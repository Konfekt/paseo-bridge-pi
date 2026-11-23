import assert from "node:assert/strict";
import test from "node:test";
import * as net from "node:net";
import * as fs from "node:fs";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handoffPathForSession, pipePathForSession, readRuntimeRecords, runtimeRegistryDirectory, writeRuntimeRecordFile } from "../shim/runtime-registry.js";
import { mergeCommands, terminalEndpoints, withSessionArg } from "../shim/session-host.js";

const here = dirname(fileURLToPath(import.meta.url));
const shim = join(here, "..", "shim", "pi-paseo-shim.js");
const fakePi = join(here, "fixtures", "fake-pi-rpc.mjs");

/** Run `fn` with HOME and XDG_RUNTIME_DIR pointing at `root`, as the shim sees them. */
function inRoot<T>(root: string, fn: () => T): T {
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_RUNTIME_DIR };
  process.env.HOME = root;
  process.env.XDG_RUNTIME_DIR = root;
  try { return fn(); } finally {
    process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved.XDG;
  }
}

async function startShim(extraArgs: string[] = [], extraEnv: Record<string, string> = {}, givenRoot?: string) {
  const root = givenRoot ?? await mkdtemp(join(tmpdir(), "pi-session-host-"));
  const sessionFile = join(root, "2026_0123456789abcdef0123.jsonl");
  const log = join(root, "fake.log");
  const env = {
    ...process.env, HOME: root, XDG_RUNTIME_DIR: root, PI_REAL_BIN: fakePi, PASEO_AGENT_ID: "agent-1",
    FAKE_SESSION_FILE: sessionFile, FAKE_LOG: log, PI_PASEO_BRIDGE_TAKEOVER_WAIT_MS: "4000", ...extraEnv,
  };
  const child = spawn(process.execPath, [shim, "--mode", "rpc", ...extraArgs], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const frames = () => output.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const waitFor = async (predicate: (frame: any) => boolean, label: string, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames().find(predicate);
      if (found) return found;
      assert(Date.now() < deadline, `timed out waiting for ${label}; got ${output} ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const launches = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  return {
    root, sessionFile, child, send, waitFor, frames, launches,
    async close() {
      child.kill("SIGKILL");
      for (const launch of launches()) { try { process.kill(launch.pid, "SIGKILL"); } catch {} }
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("pure helpers replace --session, merge commands and skip handoff sockets", () => {
  assert.deepEqual(withSessionArg(["--mode", "rpc", "--session", "a", "--session=b", "--model", "m"], "/s.jsonl"),
    ["--mode", "rpc", "--model", "m", "--session", "/s.jsonl"]);
  assert.deepEqual(mergeCommands([{ name: "model" }], [{ name: "model" }, { name: "btw", description: "x" }]),
    [{ name: "model" }, { name: "btw", description: "x", source: "extension" }]);
  const endpoints = terminalEndpoints("/p/s.jsonl", [
    { kind: "headless", bridgeSocket: "/h.sock" }, { kind: "terminal", bridgeSocket: "/t.sock" }, { bridgeSocket: "/old.sock" },
  ]);
  assert(endpoints.includes("/t.sock") && endpoints.includes("/old.sock") && !endpoints.includes("/h.sock"));
});

test("a background Pi lists bridge commands and answers them as Paseo command output", async () => {
  const f = await startShim();
  try {
    f.send({ id: "c", type: "get_commands" });
    const commands = await f.waitFor(frame => frame.id === "c", "get_commands");
    assert.deepEqual(commands.data.commands.map((command: any) => command.name), ["skill:demo", "model", "btw"]);
    f.send({ id: "o", type: "prompt", message: "/out" });
    await f.waitFor(frame => frame.type === "command_output" && frame.text === "hello from pi", "command output");
    const handled = await f.waitFor(frame => frame.id === "o", "prompt response");
    assert.equal(handled.success, true);
    assert.equal(handled.data.agentInvoked, undefined);
    assert(!f.frames().some(frame => frame.type === "extension_ui_request" && String(frame.message).startsWith("PI_PASEO_BRIDGE_FRAME")));
  } finally { await f.close(); }
});

test("a deferred /btw keeps the Paseo prompt open until its answer, and failures fail the prompt", async () => {
  const f = await startShim();
  try {
    f.send({ id: "b", type: "prompt", message: "/btw why" });
    const ack = await f.waitFor(frame => frame.id === "b" && frame.type === "response", "btw ack");
    assert.equal(ack.data.agentInvoked, true);
    await f.waitFor(frame => frame.type === "command_output" && frame.text === "btw answer", "btw answer");
    await f.waitFor(frame => frame.type === "prompt_result" && frame.id === "b" && frame.agentInvoked === false, "btw result");
    f.send({ id: "x", type: "prompt", message: "/bad" });
    const failed = await f.waitFor(frame => frame.id === "x", "failure");
    assert.deepEqual([failed.success, failed.error], [false, "bad command"]);
  } finally { await f.close(); }
});

test("/autocompact from Paseo applies to this session only and shows in get_state", async () => {
  const f = await startShim();
  try {
    f.send({ id: "c", type: "get_commands" });
    await f.waitFor(frame => frame.id === "c", "commands");
    f.send({ id: "a", type: "set_auto_compaction", enabled: false });
    const response = await f.waitFor(frame => frame.id === "a", "set_auto_compaction");
    assert.deepEqual([response.command, response.success], ["set_auto_compaction", true]);
    f.send({ id: "s", type: "get_state" });
    assert.equal((await f.waitFor(frame => frame.id === "s", "state")).data.autoCompactionEnabled, false);
  } finally { await f.close(); }
});

test("a terminal takes a background session over once idle, and Paseo follows it there", async () => {
  const f = await startShim([], { FAKE_BUSY_MS: "800" });
  try {
    f.send({ id: "busy", type: "prompt", message: "/busy" });
    await f.waitFor(frame => frame.id === "busy", "busy ack");
    const deadline = Date.now() + 4000;
    let record: any;
    while (!record && Date.now() < deadline) {
      record = inRoot(f.root, () => readRuntimeRecords(runtimeRegistryDirectory())).find((entry: any) => entry.kind === "headless");
      if (!record) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(record, "background record published");
    assert.equal(record.agentId, "agent-1");
    assert.equal(record.bridgeSocket, inRoot(f.root, () => handoffPathForSession(f.sessionFile)));
    // The terminal's controller endpoint, which the shim attaches to after the handoff.
    const controllerPath = inRoot(f.root, () => pipePathForSession(f.sessionFile));
    const controller = net.createServer();
    controller.listen(controllerPath);
    await once(controller, "listening");
    const socket = net.connect(record.bridgeSocket);
    await once(socket, "connect");
    let replies = "";
    socket.on("data", chunk => { replies += chunk; });
    socket.write(`${JSON.stringify({ type: "takeover", pid: process.pid })}\n`);
    const until = async (text: string) => {
      const end = Date.now() + 5000;
      while (!replies.includes(text)) {
        assert(Date.now() < end, `expected ${text}, got ${replies}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await until('"waiting"');
    const connected = once(controller, "connection");
    await until('"released"');
    assert.match(replies, /"agentId":"agent-1"/);
    const [terminal] = await connected as [net.Socket];
    let forwarded = "";
    terminal.on("data", chunk => { forwarded += chunk; });
    f.send({ id: "after", type: "get_state" });
    const end = Date.now() + 3000;
    while (!forwarded.includes('"after"')) {
      assert(Date.now() < end, "Paseo input reaches the terminal");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    terminal.write(`${JSON.stringify({ id: "after", type: "response", command: "get_state", success: true, data: { fromTerminal: true } })}\n`);
    assert.equal((await f.waitFor(frame => frame.id === "after", "terminal reply")).data.fromTerminal, true);
    assert.equal(inRoot(f.root, () => readRuntimeRecords(runtimeRegistryDirectory())).some((entry: any) => entry.kind === "headless"), false);
    terminal.destroy();
    controller.close();
    socket.destroy();
  } finally { await f.close(); }
});

test("when the terminal Pi closes, the chat continues in a background Pi on the same session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-host-term-"));
  const sessionFile = join(root, "2026_0123456789abcdef0123.jsonl");
  const controllerPath = inRoot(root, () => pipePathForSession(sessionFile));
  fs.mkdirSync(dirname(controllerPath), { recursive: true });
  const controller = net.createServer();
  controller.listen(controllerPath);
  await once(controller, "listening");
  const f = await startShim(["--session", sessionFile, "--model", "m"], {}, root);
  try {
    const [terminal] = await once(controller, "connection") as [net.Socket];
    f.send({ id: "lost", type: "get_state" });
    await new Promise(resolve => setTimeout(resolve, 100));
    terminal.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    await f.waitFor(frame => frame.type === "agent_start", "turn start");
    terminal.destroy();
    const failed = await f.waitFor(frame => frame.id === "lost", "pending request failed");
    assert.equal(failed.success, false);
    await f.waitFor(frame => frame.type === "agent_end", "turn ended");
    await f.waitFor(frame => frame.method === "notify" && /continues this session in the background/.test(frame.message), "notice");
    f.send({ id: "next", type: "get_state" });
    const next = await f.waitFor(frame => frame.id === "next", "background reply");
    assert.equal(next.data.sessionFile, sessionFile);
    const [launch] = f.launches();
    assert.deepEqual(launch.args.slice(-4), ["--model", "m", "--session", sessionFile]);
  } finally {
    controller.close();
    await f.close();
  }
});

test("a terminal that disconnects but still owns the session gets the tombstone, not a second writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-host-owner-"));
  const sessionFile = join(root, "2026_0123456789abcdef0123.jsonl");
  const controllerPath = inRoot(root, () => pipePathForSession(sessionFile));
  fs.mkdirSync(dirname(controllerPath), { recursive: true });
  const controller = net.createServer();
  controller.listen(controllerPath);
  await once(controller, "listening");
  // This test process stands in for the live terminal Pi.
  inRoot(root, () => writeRuntimeRecordFile({ kind: "terminal", sessionFile, pid: process.pid, bridgeSocket: controllerPath }, runtimeRegistryDirectory()));
  const f = await startShim(["--session", sessionFile], {}, root);
  try {
    const [terminal] = await once(controller, "connection") as [net.Socket];
    terminal.destroy();
    const exit = await f.waitFor(frame => frame.type === "process_exit", "tombstone", 9000);
    assert.match(exit.error, /still owns this session/);
    assert.equal(f.launches().length, 0);
  } finally {
    controller.close();
    await f.close();
  }
});
