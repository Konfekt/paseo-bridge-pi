#!/usr/bin/env node
// pi-paseo-shim: configured as Paseo's `pi` provider command. If the session
// Paseo is resuming has a live TUI process (detected via the bridge pipe the
// pi-paseo-bridge extension opens), bridge stdio to that pipe. Otherwise run
// the real pi in RPC mode in the background. Either way the session can later
// move between the terminal and the background Pi; see session-host.js.
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import {
	assertNoLiveRuntimeOwner,
	matchingRuntimeRecords,
} from "./runtime-registry.js";
import { createSessionHost, terminalEndpoints, tryConnect } from "./session-host.js";
const args = process.argv.slice(2);

function extractSessionArg(argv) {
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--session" && argv[i + 1]) return argv[i + 1];
		if (argv[i].startsWith("--session="))
			return argv[i].slice("--session=".length);
	}
	return null;
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

/** Paseo's metadata helpers run a plain Pi child, never a shared session. */
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

function spawnPi(childArgs, env) {
	const real = resolveRealPi();
	if (!real)
		throw new Error("Could not locate the real Pi executable. Set PI_REAL_BIN to its executable or cli.js.");
	return spawn(real.command, [...real.prefix, ...childArgs], {
		stdio: ["pipe", "pipe", "pipe"],
		env,
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
	let terminal = null;
	if (sessionFile) {
		for (const endpoint of terminalEndpoints(sessionFile, runtimeRecords)) {
			terminal = await tryConnect(endpoint);
			if (terminal) break;
		}
		// A failed connection can mean startup/reload, permissions, or a live
		// runtime (terminal or background) whose endpoint is down. Never unlink
		// another owner's endpoint or mistake transport failure for permission
		// to spawn a writer.
		if (!terminal)
			assertNoLiveRuntimeOwner(sessionFile, {
				agentId: assignedAgentId,
				records: runtimeRecords,
			});
	}
	if (!terminal && !resolveRealPi())
		throw new Error("Could not locate the real Pi executable. Set PI_REAL_BIN to its executable or cli.js.");
	const host = createSessionHost({ args, spawnPi });
	if (terminal) host.attachTerminal(terminal, sessionFile);
	else host.startChild(args);
}

main().catch((error) => {
	process.stderr.write(`pi-paseo-shim: ${String(error.message ?? error)}\n`);
	process.exitCode = 1;
});
