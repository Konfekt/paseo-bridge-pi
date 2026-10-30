#!/usr/bin/env node
// pi-paseo-shim: configured as Paseo's `pi` provider command. If the session
// Paseo is resuming has a live TUI process (detected via the bridge pipe the
// pi-paseo-bridge extension opens), bridge stdio to that pipe. Otherwise spawn
// the real pi with unchanged argv so Paseo-native behaviour is preserved.
import net from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
	assertNoLiveRuntimeOwner,
	matchingRuntimeRecords,
} from "./runtime-registry.js";
const CONNECT_TIMEOUT_MS = 500;
const args = process.argv.slice(2);

// Keep in sync with extension/index.ts (pipePathForSession).
function pipePathForSession(sessionFile) {
	let normalized = path.resolve(sessionFile);
	if (process.platform === "win32") normalized = normalized.toLowerCase();
	const hash = crypto
		.createHash("sha256")
		.update(normalized)
		.digest("hex")
		.slice(0, 20);
	if (process.platform === "win32")
		return `\\\\.\\pipe\\pi-paseo-bridge-${hash}`;
	const dir = process.env.XDG_RUNTIME_DIR
		? path.join(process.env.XDG_RUNTIME_DIR, "pi-paseo")
		: path.join(os.homedir(), ".pi", "paseo-bridge");
	return path.join(dir, `${hash}.sock`);
}

function extractSessionArg(argv) {
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--session" && argv[i + 1]) return argv[i + 1];
		if (argv[i].startsWith("--session="))
			return argv[i].slice("--session=".length);
	}
	return null;
}

function tryConnect(pipePath) {
	return new Promise((resolve) => {
		const socket = net.connect(pipePath);
		const fail = () => {
			socket.destroy();
			resolve(null);
		};
		const timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
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

function writeJsonLine(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function sessionIdFromFile(sessionFile) {
	const base = path.basename(sessionFile, ".jsonl");
	const idx = base.lastIndexOf("_");
	const id = idx >= 0 ? base.slice(idx + 1) : "";
	return /^[0-9a-f-]{16,}$/i.test(id) ? id : null;
}

function bridge(socket, sessionFile) {
	socket.setNoDelay?.(true);
	let tombstone = false;
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
	process.stdin.on("end", () => {
		if (tombstone) process.exit(0);
		else socket.end();
	});
	// When the terminal pi dies, stay alive and answer RPC commands with a
	// helpful error instead of exiting - a dead child would make Paseo show a
	// bare "Pi RPC session is closed" with no way forward.
	const enterTombstone = () => {
		if (tombstone) return;
		tombstone = true;
		const resumeRef = sessionIdFromFile(sessionFile) ?? sessionFile;
		const message = `The terminal pi session has ended. Resume it from the project directory with: pi --session ${resumeRef}.`;
		process.stdin.unpipe(socket);
		// Fails any in-flight turn: Paseo treats process_exit as a fatal runtime event.
		writeJsonLine({ type: "process_exit", error: message });
		let buffer = "";
		process.stdin.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				let parsed;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue;
				}
				if (parsed && typeof parsed === "object" && parsed.id) {
					writeJsonLine({
						type: "response",
						id: parsed.id,
						command: typeof parsed.type === "string" ? parsed.type : "unknown",
						success: false,
						error: message,
					});
				}
			}
		});
		process.stdin.resume();
	};
	socket.on("close", enterTombstone);
	socket.on("error", enterTombstone);
}

function resolveRealPi() {
	const override = process.env.PI_REAL_BIN;
	if (override) {
		if (
			override.endsWith(".js") ||
			override.endsWith(".mjs") ||
			override.endsWith(".cjs")
		) {
			return { command: process.execPath, prefix: [override] };
		}
		return { command: override, prefix: [] };
	}
	const pathDirs = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean);
	const names =
		process.platform === "win32"
			? ["pi.cmd", "pi.bat", "pi.exe", "pi"]
			: ["pi"];
	for (const dir of pathDirs) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			let stat;
			try {
				stat = fs.statSync(candidate);
			} catch {
				continue;
			}
			if (!stat.isFile()) continue;
			// npm-style launcher (.cmd or extensionless sh script): spawn the JS
			// entry directly with node, since Node refuses to spawn .cmd files
			// without a shell and shell quoting is unsafe.
			const npmEntry = path.join(
				dir,
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"dist",
				"cli.js",
			);
			if (fs.existsSync(npmEntry) && !candidate.endsWith(".exe")) {
				return { command: process.execPath, prefix: [npmEntry] };
			}
			if (process.platform === "win32" && !candidate.endsWith(".exe")) continue;
			return { command: candidate, prefix: [] };
		}
	}
	return null;
}

/** Native RPC sessions belong to the Pi child, never a bridge-managed TUI. */
function passthrough() {
	const real = resolveRealPi();
	if (!real)
		throw new Error("Could not locate the real Pi executable. Set PI_REAL_BIN to its executable or cli.js.");
	const child = spawn(real.command, [...real.prefix, ...args], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stopping = false;
	let killTimer;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		process.stdin.unpipe(child.stdin);
		child.stdin.end();
		child.kill("SIGTERM");
		killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
		killTimer.unref();
	};
	process.stdin.pipe(child.stdin);
	child.stdout.pipe(process.stdout);
	child.stderr.pipe(process.stderr);
	process.stdin.once("end", stop);
	process.stdin.once("error", stop);
	process.stdout.once("error", stop);
	process.stderr.once("error", stop);
	child.stdin.on("error", stop);
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	child.once("error", (error) => {
		process.stderr.write(
			`pi-paseo-shim: native Pi RPC failed: ${error.message}\n`,
		);
		stop();
	});
	child.once("close", (code, signal) => {
		clearTimeout(killTimer);
		process.stdin.unpipe(child.stdin);
		process.exit(signal ? 1 : (code ?? 1));
	});
}

async function main() {
	// Paseo marks internal metadata generation with --no-session. Check before
	// attachment lookup so a helper cannot connect to an interactive session.
	if (args.includes("--no-session")) {
		passthrough();
		return;
	}
	let sessionFile = extractSessionArg(args);
	const assignedAgentId = process.env.PASEO_AGENT_ID?.trim();
	const runtimeRecords = matchingRuntimeRecords(sessionFile, assignedAgentId);
	if (!sessionFile && runtimeRecords.length)
		sessionFile = runtimeRecords[0].sessionFile;
	if (sessionFile) {
		const candidatePaths = [
			...runtimeRecords
				.filter((record) => typeof record.bridgeSocket === "string")
				.map((record) => record.bridgeSocket),
			pipePathForSession(sessionFile),
		];
		for (const pipePath of [...new Set(candidatePaths)]) {
			const socket = await tryConnect(pipePath);
			if (socket) {
				bridge(socket, sessionFile);
				return;
			}
		}
		// A failed connection can mean startup/reload, permissions, or a live
		// terminal runtime whose bridge is down. Never unlink another owner's
		// endpoint or mistake transport failure for permission to spawn a writer.
		assertNoLiveRuntimeOwner(sessionFile, {
			agentId: assignedAgentId,
			records: runtimeRecords,
		});
	}
	passthrough();
}

main().catch((error) => {
	process.stderr.write(`pi-paseo-shim: ${String(error.message ?? error)}\n`);
	process.exitCode = 1;
});
