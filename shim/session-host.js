// One Paseo provider connection whose Pi can move between a background
// (headless) Pi child and a terminal Pi, in both directions:
//
//   Paseo stdio <-> shim <-> pi --mode rpc child        (chat started in Paseo,
//                                                        or terminal closed)
//   Paseo stdio <-> shim <-> terminal Pi controller      (pi in a terminal)
//
// Only one Pi writes a session at a time. A terminal Pi that resumes a session
// asks this shim, through the handoff socket, to stop its idle child first. When
// the terminal Pi closes, the shim resumes the session in a new child, so the
// Paseo chat keeps working.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { jsonLine, lineReader, parseJson } from "./jsonl.js";
import {
	bridgeStateDirectory,
	handoffPathForSession,
	isHeadlessRecord,
	matchingRuntimeRecords,
	pipePathForSession,
	processStartToken,
	removeRuntimeRecordFile,
	runtimeOwnerMayBeAlive,
	writeRuntimeRecordFile,
} from "./runtime-registry.js";

import { FRAME_MARKER, SHIM_PROTOCOL_ENV } from "./protocol.js";

export { FRAME_MARKER, SHIM_PROTOCOL_ENV };
const SHIM_ID_PREFIX = "pi-paseo-shim:";
const CONNECT_TIMEOUT_MS = 500;
const CHILD_STOP_TIMEOUT_MS = 5000;
const OWNER_RELEASE_WAIT_MS = 5000;
const REPLY_TIMEOUT_MS = 10_000;
const HANDOFF_POLL_MS = 500;
const SESSION_CHANGING_COMMANDS = new Set(["new_session", "switch_session", "fork", "clone"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function sessionIdFromFile(sessionFile) {
	const base = path.basename(sessionFile, ".jsonl");
	const idx = base.lastIndexOf("_");
	const id = idx >= 0 ? base.slice(idx + 1) : "";
	return /^[0-9a-f-]{16,}$/i.test(id) ? id : null;
}

/** Replace any `--session` argument with the given session file. */
export function withSessionArg(args, sessionFile) {
	const result = [];
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === "--session") {
			i += 1;
			continue;
		}
		if (args[i].startsWith("--session=")) continue;
		result.push(args[i]);
	}
	return [...result, "--session", sessionFile];
}

export function tryConnect(pipePath, timeoutMs = CONNECT_TIMEOUT_MS) {
	return new Promise((resolve) => {
		const socket = net.connect(pipePath);
		const fail = () => {
			socket.destroy();
			resolve(null);
		};
		const timer = setTimeout(fail, timeoutMs);
		socket.once("error", () => {
			clearTimeout(timer);
			fail();
		});
		socket.once("connect", () => {
			clearTimeout(timer);
			resolve(socket);
		});
	});
}

/** Controller endpoints of terminal Pi owners of a session; never a handoff socket. */
export function terminalEndpoints(sessionFile, records) {
	const recorded = records
		.filter((record) => !isHeadlessRecord(record) && typeof record.bridgeSocket === "string")
		.map((record) => record.bridgeSocket);
	return [...new Set([...recorded, pipePathForSession(sessionFile)])];
}

/** Add the bridge's commands to Pi's command list unless Pi already has them. */
export function mergeCommands(commands, extra) {
	const list = Array.isArray(commands) ? commands : [];
	const taken = new Set(list.map((command) => command?.name));
	return [...list, ...extra.filter((command) => !taken.has(command.name)).map((command) => ({ ...command, source: "extension" }))];
}

function liveTerminalOwner(sessionFile) {
	try {
		return matchingRuntimeRecords(sessionFile, null).find((record) =>
			!isHeadlessRecord(record) && record.pid !== process.pid && runtimeOwnerMayBeAlive(record));
	} catch {
		// An unreadable registry is not evidence that the owner exited.
		return { pid: 0 };
	}
}

/**
 * @param {object} options
 * @param {string[]} options.args Paseo's Pi arguments.
 * @param {(args: string[], env: NodeJS.ProcessEnv) => import("node:child_process").ChildProcess} options.spawnPi
 */
export function createSessionHost(options) {
	const {
		args,
		spawnPi,
		env = process.env,
		input = process.stdin,
		output = process.stdout,
		errorOutput = process.stderr,
		exit = (code) => process.exit(code),
	} = options;
	const agentId = env.PASEO_AGENT_ID?.trim() || null;
	const resumeEnabled = env.PI_PASEO_BRIDGE_HEADLESS_RESUME !== "0";
	const takeoverWaitMs = Number(env.PI_PASEO_BRIDGE_TAKEOVER_WAIT_MS) || 30_000;
	let backend = null;
	let held = [];
	let holding = false;
	let inputEnded = false;
	let exiting = false;
	// Paseo requests the current backend has not answered, and whether a turn runs.
	const pending = new Map();
	let turnActive = false;

	const debug = env.PI_PASEO_BRIDGE_DEBUG === "1" || env.PI_PASEO_BRIDGE_DEBUG === "true";
	const debugFile = path.join(bridgeStateDirectory(), "shim-debug.log");
	const trace = (direction, line) => {
		if (!debug) return;
		try {
			fs.mkdirSync(path.dirname(debugFile), { recursive: true });
			fs.appendFileSync(debugFile, `${new Date().toISOString()} ${process.pid} ${direction} ${String(line).slice(0, 400)}\n`);
		} catch {}
	};
	const writeLine = (line) => {
		trace("->paseo", line);
		output.write(line.endsWith("\n") ? line : `${line}\n`);
	};
	const writeFrame = (value) => writeLine(jsonLine(value));
	const notice = (message, notifyType = "info") =>
		writeFrame({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType });
	const failure = (id, command, error) => ({ type: "response", id, command, success: false, error });

	function finish(code) {
		if (exiting) return;
		exiting = true;
		if (backend?.kind === "child") unpublishHeadless(backend);
		exit(code);
	}

	function trackTurn(msg) {
		if (msg.type === "agent_start") turnActive = true;
		else if (msg.type === "agent_settled" || (msg.type === "agent_end" && msg.willRetry !== true)) turnActive = false;
	}

	function flushHeld() {
		const lines = held;
		held = [];
		for (const line of lines) onPaseoLine(line, parseJson(line));
	}

	function onPaseoLine(line, msg) {
		trace(`paseo-> [${backend?.kind ?? "none"}${holding ? ", held" : ""}]`, line);
		if (holding || !backend || backend.kind === "pending") {
			held.push(line);
			return;
		}
		if (backend.kind === "tombstone") {
			if (msg?.id != null) writeFrame(failure(msg.id, typeof msg.type === "string" ? msg.type : "unknown", backend.message));
			return;
		}
		if (msg?.id != null && msg.type !== "extension_ui_response") pending.set(msg.id, typeof msg.type === "string" ? msg.type : "unknown");
		if (backend.kind === "terminal") {
			backend.socket.write(`${line}\n`);
			return;
		}
		childInput(backend, line, msg);
	}

	lineReader(input, onPaseoLine);
	const onInputEnd = () => {
		if (inputEnded) return;
		inputEnded = true;
		if (backend?.kind === "child") stopChild(backend, "exit");
		else if (backend?.kind === "terminal") backend.socket.end();
		else finish(0);
	};
	input.once("end", onInputEnd);
	input.once("error", onInputEnd);

	// ---------------------------------------------------------------- terminal

	function attachTerminal(socket, sessionFile) {
		socket.setNoDelay?.(true);
		pending.clear();
		turnActive = false;
		const state = { kind: "terminal", socket, sessionFile };
		backend = state;
		lineReader(socket, (line, msg) => {
			if (backend !== state) return;
			if (msg?.type === "response") pending.delete(msg.id);
			if (msg) trackTurn(msg);
			writeLine(line);
		});
		let lost = false;
		const onLost = () => {
			if (lost) return;
			lost = true;
			if (backend === state) void terminalLost(sessionFile);
		};
		socket.on("close", onLost);
		socket.on("error", onLost);
		flushHeld();
	}

	async function terminalLost(sessionFile) {
		if (inputEnded) return finish(0);
		backend = { kind: "pending" };
		if (!resumeEnabled) return tombstone(sessionFile);
		// The terminal removes its record before it closes the controller; a
		// crashed Pi leaves a record whose process is gone.
		const deadline = Date.now() + OWNER_RELEASE_WAIT_MS;
		while (liveTerminalOwner(sessionFile) && Date.now() < deadline) await sleep(100);
		if (inputEnded) return finish(0);
		if (liveTerminalOwner(sessionFile)) return tombstone(sessionFile);
		const reason = "The terminal Pi closed before answering; Pi now continues this session in the background.";
		for (const [id, command] of pending) writeFrame(failure(id, command, reason));
		pending.clear();
		if (turnActive) writeFrame({ type: "agent_end", messages: [] });
		turnActive = false;
		const ref = sessionIdFromFile(sessionFile) ?? sessionFile;
		if (resumeInChild(sessionFile)) {
			notice(`The terminal Pi closed. Pi continues this session in the background for Paseo; run pi --session ${ref} in a terminal to take it back.`);
		}
	}

	/** Continue a session without a terminal; false (and a tombstone) if Pi cannot start. */
	function resumeInChild(sessionFile) {
		try {
			startChild(withSessionArg(args, sessionFile), sessionFile);
			return true;
		} catch (error) {
			errorOutput.write(`pi-paseo-shim: ${String(error?.message ?? error)}\n`);
			tombstone(sessionFile);
			return false;
		}
	}

	function tombstone(sessionFile) {
		const ref = sessionIdFromFile(sessionFile) ?? sessionFile;
		const live = liveTerminalOwner(sessionFile);
		const message = live
			? `The terminal Pi (PID ${live.pid}) disconnected from Paseo but still owns this session. Reconnect it with /paseo-bridge connect in that terminal, or quit it there.`
			: `The terminal pi session has ended. Resume it from the project directory with: pi --session ${ref}.`;
		// Fails any in-flight turn: Paseo treats process_exit as a fatal runtime event.
		writeFrame({ type: "process_exit", error: message });
		pending.clear();
		backend = { kind: "tombstone", message };
		flushHeld();
	}

	/** After a handoff, attach to the terminal Pi once its controller listens. */
	async function awaitTerminal(sessionFile) {
		const deadline = Date.now() + takeoverWaitMs;
		while (Date.now() < deadline && !inputEnded) {
			let records = [];
			try { records = matchingRuntimeRecords(sessionFile, null); } catch {}
			for (const endpoint of terminalEndpoints(sessionFile, records)) {
				const socket = await tryConnect(endpoint);
				if (!socket) continue;
				attachTerminal(socket, sessionFile);
				return;
			}
			await sleep(250);
		}
		if (inputEnded) return finish(0);
		if (liveTerminalOwner(sessionFile)) return tombstone(sessionFile);
		if (resumeInChild(sessionFile)) {
			notice("The terminal did not take this session over; Pi continues it in the background for Paseo.", "warning");
		}
	}

	// ------------------------------------------------------------------- child

	function startChild(childArgs, knownSessionFile = null) {
		const child = spawnPi(childArgs, { ...env, [SHIM_PROTOCOL_ENV]: "1" });
		const state = {
			kind: "child",
			child,
			sessionFile: null,
			published: null,
			sequence: 0,
			injected: new Map(),
			replies: new Map(),
			prompts: new Map(),
			deferred: new Map(),
			commands: [],
			capabilities: {},
			autoCompaction: null,
			handoff: null,
			stopping: null,
			closed: new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
		};
		backend = state;
		pending.clear();
		turnActive = false;
		lineReader(child.stdout, (line, msg) => childOutput(state, line, msg));
		child.stderr?.on("data", (chunk) => errorOutput.write(chunk));
		child.stdin.on("error", () => stopChild(state, "exit"));
		child.once("error", (error) => {
			errorOutput.write(`pi-paseo-shim: native Pi RPC failed: ${error.message}\n`);
			stopChild(state, "exit");
		});
		void state.closed.then(({ code, signal }) => {
			if (state.stopping === "handoff") return;
			finish(signal ? 1 : (code ?? 1));
		});
		if (knownSessionFile) adoptSessionFile(state, knownSessionFile);
		void refreshSessionFile(state);
		flushHeld();
		return state;
	}

	function stopChild(state, reason) {
		if (state.stopping) return state.closed;
		state.stopping = reason;
		try { state.child.stdin.end(); } catch {}
		state.child.kill("SIGTERM");
		const timer = setTimeout(() => state.child.kill("SIGKILL"), CHILD_STOP_TIMEOUT_MS);
		timer.unref?.();
		void state.closed.then(() => clearTimeout(timer));
		return state.closed;
	}

	function inject(state, command) {
		const id = `${SHIM_ID_PREFIX}${++state.sequence}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				state.injected.delete(id);
				resolve({ success: false, error: "Pi did not answer in time" });
			}, REPLY_TIMEOUT_MS);
			timer.unref?.();
			state.injected.set(id, (response) => {
				clearTimeout(timer);
				resolve(response);
			});
			if (!state.stopping) state.child.stdin.write(jsonLine({ ...command, id }));
		});
	}

	function waitForReply(state, token) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				state.replies.delete(token);
				resolve({ ok: false, error: "Pi did not answer in time" });
			}, REPLY_TIMEOUT_MS);
			timer.unref?.();
			state.replies.set(token, (frame) => {
				clearTimeout(timer);
				resolve(frame);
			});
		});
	}

	async function refreshSessionFile(state) {
		const response = await inject(state, { type: "get_state" });
		if (response?.success && typeof response.data?.sessionFile === "string") adoptSessionFile(state, response.data.sessionFile);
	}

	function adoptSessionFile(state, file) {
		const resolved = path.resolve(file);
		if (state.sessionFile === resolved) return;
		unpublishHeadless(state);
		state.sessionFile = resolved;
		publishHeadless(state);
	}

	/** Let a terminal Pi resuming this session find and ask this shim. */
	function publishHeadless(state) {
		const sessionFile = state.sessionFile;
		if (!sessionFile || state.stopping || liveTerminalOwner(sessionFile)) return;
		const handoffPath = handoffPathForSession(sessionFile);
		try {
			if (process.platform !== "win32") {
				fs.mkdirSync(path.dirname(handoffPath), { recursive: true, mode: 0o700 });
				try { fs.unlinkSync(handoffPath); } catch {}
			}
			const server = net.createServer((socket) => {
				socket.on("error", () => {});
				let attempt = null;
				lineReader(socket, (_line, msg) => {
					if (msg?.type === "takeover" && !attempt) attempt = handoff(state, socket, msg);
					else if (msg?.type === "force" && state.handoff?.socket === socket) state.handoff.force = true;
				});
			});
			server.on("error", (error) => errorOutput.write(`pi-paseo-shim: handoff socket failed: ${error.message}\n`));
			server.listen(handoffPath, () => {
				if (process.platform !== "win32") {
					try { fs.chmodSync(handoffPath, 0o600); } catch {}
				}
			});
			writeRuntimeRecordFile({
				schemaVersion: 3,
				kind: "headless",
				processStartToken: processStartToken(),
				sessionFile,
				bridgeSocket: handoffPath,
				agentId,
				cwd: process.cwd(),
				pid: process.pid,
			});
			state.published = { sessionFile, handoffPath, server };
		} catch (error) {
			errorOutput.write(`pi-paseo-shim: could not publish the background session: ${error.message}\n`);
		}
	}

	function unpublishHeadless(state) {
		const published = state.published;
		if (!published) return;
		state.published = null;
		removeRuntimeRecordFile(published.sessionFile);
		try { published.server.close(); } catch {}
		if (process.platform !== "win32") {
			try { fs.unlinkSync(published.handoffPath); } catch {}
		}
	}

	async function busyReason(state) {
		if (state.prompts.size || state.deferred.size) return "a message from Paseo is being handled";
		const response = await inject(state, { type: "get_state" });
		if (!response?.success) return "Pi state is unavailable";
		const data = response.data ?? {};
		if (data.isCompacting) return "Pi is compacting the context";
		if (data.isStreaming) return "Pi is working on a turn";
		if (data.pendingMessageCount) return "messages are queued";
		return null;
	}

	function releaseDeferred(state) {
		for (const [id, entry] of state.deferred) {
			if (!entry.responded) continue;
			writeFrame({ type: "prompt_result", id, agentInvoked: false });
			state.deferred.delete(id);
		}
	}

	async function handoff(state, socket, request) {
		const reply = (value) => { if (!socket.destroyed) socket.write(jsonLine(value)); };
		if (state.handoff || state.stopping || backend !== state) {
			reply({ type: "refused", reason: "a handoff is already in progress" });
			socket.end();
			return;
		}
		const attempt = { socket, cancelled: false, force: request.force === true, forced: false };
		state.handoff = attempt;
		socket.once("close", () => { attempt.cancelled = true; });
		let lastReason;
		for (;;) {
			if (attempt.cancelled || backend !== state || state.stopping) {
				if (state.handoff === attempt) state.handoff = null;
				return;
			}
			if (attempt.force && !attempt.forced) {
				// The terminal asked to stop Paseo's work now rather than wait for it.
				attempt.forced = true;
				const sideQuestion = state.deferred.size > 0;
				releaseDeferred(state);
				if (sideQuestion) void inject(state, { type: "prompt", message: "/paseo-bridge headless-cancel" });
				await inject(state, { type: "abort" });
			}
			const reason = await busyReason(state);
			if (!reason) {
				// Hold Paseo's input, then confirm nothing slipped in meanwhile.
				holding = true;
				if (!await busyReason(state) && !attempt.cancelled) break;
				holding = false;
				flushHeld();
				continue;
			}
			if (reason !== lastReason) reply({ type: "waiting", reason });
			lastReason = reason;
			await sleep(HANDOFF_POLL_MS);
		}
		const sessionFile = state.sessionFile;
		backend = { kind: "pending" };
		holding = false;
		await stopChild(state, "handoff");
		unpublishHeadless(state);
		reply({ type: "released", sessionFile, agentId });
		socket.end();
		notice("This session moved to a terminal Pi; Paseo follows it there.");
		await awaitTerminal(sessionFile);
	}

	function findPrompt(state, message) {
		for (const [id, text] of state.prompts) {
			if (text === message && !state.deferred.has(id)) return id;
		}
		return undefined;
	}

	function handleFrame(state, frame) {
		if (!frame) return;
		switch (frame.op) {
			case "commands":
				state.commands = Array.isArray(frame.commands) ? frame.commands : [];
				state.capabilities = frame.capabilities ?? {};
				return;
			case "output":
				if (typeof frame.text === "string" && frame.text.trim()) writeFrame({ type: "command_output", text: frame.text });
				return;
			case "defer": {
				const id = findPrompt(state, frame.message);
				if (id !== undefined) state.deferred.set(id, { message: frame.message, done: false, responded: false });
				return;
			}
			case "fail": {
				const id = findPrompt(state, frame.message);
				if (id !== undefined) state.deferred.set(id, { message: frame.message, failed: String(frame.error ?? "Command failed"), responded: false });
				return;
			}
			case "done":
				for (const [id, entry] of state.deferred) {
					if (entry.message !== frame.message || entry.done) continue;
					if (entry.responded) {
						writeFrame({ type: "prompt_result", id, agentInvoked: false });
						state.deferred.delete(id);
					} else {
						entry.done = true;
					}
					return;
				}
				return;
			case "autocompact":
				if (typeof frame.enabled === "boolean") state.autoCompaction = frame.enabled;
				return;
			case "reply":
				state.replies.get(frame.token)?.(frame);
				state.replies.delete(frame.token);
				return;
			default:
		}
	}

	function childInput(state, line, msg) {
		if (state.stopping) {
			held.push(line);
			return;
		}
		if (msg?.type === "set_auto_compaction" && msg.id != null && typeof msg.enabled === "boolean" && state.capabilities.autocompact) {
			// Pi's own setting is global; the bridge applies it to this session only, as in a terminal.
			const token = randomUUID();
			const result = waitForReply(state, token);
			void inject(state, { type: "prompt", message: `/paseo-bridge headless-autocompact ${msg.enabled ? "on" : "off"} ${token}` });
			void result.then((frame) => {
				pending.delete(msg.id);
				writeFrame(frame.ok
					? { type: "response", id: msg.id, command: "set_auto_compaction", success: true }
					: failure(msg.id, "set_auto_compaction", String(frame.error ?? "Auto-compaction change failed")));
			});
			return;
		}
		if (msg?.type === "abort" && state.deferred.size) {
			// Paseo's Stop targets the side question it waits for.
			releaseDeferred(state);
			void inject(state, { type: "prompt", message: "/paseo-bridge headless-cancel" });
		}
		if (msg?.type === "prompt" && msg.id != null && typeof msg.message === "string") state.prompts.set(msg.id, msg.message);
		state.child.stdin.write(`${line}\n`);
	}

	function childOutput(state, line, msg) {
		trace("pi->", line);
		if (!msg) {
			writeLine(line);
			return;
		}
		if (msg.type === "response" && typeof msg.id === "string" && msg.id.startsWith(SHIM_ID_PREFIX)) {
			state.injected.get(msg.id)?.(msg);
			state.injected.delete(msg.id);
			return;
		}
		if (msg.type === "extension_ui_request" && msg.method === "notify" && typeof msg.message === "string"
			&& msg.message.startsWith(`${FRAME_MARKER} `)) {
			handleFrame(state, parseJson(msg.message.slice(FRAME_MARKER.length + 1)));
			return;
		}
		if (msg.type !== "response") {
			trackTurn(msg);
			writeLine(line);
			return;
		}
		pending.delete(msg.id);
		let reply = msg;
		if (msg.command === "get_commands" && msg.success && state.commands.length) {
			reply = { ...msg, data: { ...msg.data, commands: mergeCommands(msg.data?.commands, state.commands) } };
		} else if (msg.command === "get_state" && msg.success && msg.data) {
			if (state.autoCompaction === false) reply = { ...msg, data: { ...msg.data, autoCompactionEnabled: false } };
			if (typeof msg.data.sessionFile === "string") adoptSessionFile(state, msg.data.sessionFile);
		} else if (msg.command === "prompt") {
			const entry = state.deferred.get(msg.id);
			state.prompts.delete(msg.id);
			if (entry?.failed) {
				state.deferred.delete(msg.id);
				reply = msg.success ? failure(msg.id, "prompt", entry.failed) : msg;
			} else if (entry && msg.success && !entry.done) {
				entry.responded = true;
				reply = { ...msg, data: { ...msg.data, agentInvoked: true } };
			} else if (entry) {
				state.deferred.delete(msg.id);
			}
		} else if (SESSION_CHANGING_COMMANDS.has(msg.command) && msg.success) {
			void refreshSessionFile(state);
		}
		writeLine(reply === msg ? line : jsonLine(reply));
	}

	const shutdown = () => {
		if (backend?.kind === "child") stopChild(backend, "exit");
		else finish(0);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
	process.once("exit", () => {
		if (backend?.kind === "child") unpublishHeadless(backend);
	});

	return {
		attachTerminal,
		startChild: (childArgs = args) => startChild(childArgs),
		get backend() { return backend; },
	};
}
