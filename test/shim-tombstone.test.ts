import assert from "node:assert/strict";
import test from "node:test";
import * as net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipePathForSession } from "../shim/runtime-registry.js";

const shim = join(dirname(fileURLToPath(import.meta.url)), "..", "shim", "pi-paseo-shim.js");

async function attachedShim() {
  const root = await mkdtemp(join(tmpdir(), "pi-shim-tombstone-"));
  const env = { ...process.env, HOME: root, XDG_RUNTIME_DIR: root, PI_PASEO_BRIDGE_HEADLESS_RESUME: "0" };
  const sessionFile = join(root, "2026_0123456789abcdef0123.jsonl");
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = root;
  const socketPath = pipePathForSession(sessionFile);
  if (previous === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous;
  await mkdir(dirname(socketPath), { recursive: true });
  const server = net.createServer();
  server.listen(socketPath);
  await once(server, "listening");
  const child = spawn(process.execPath, [shim, "--mode", "rpc", "--session", sessionFile], { env, stdio: ["pipe", "pipe", "pipe"] });
  const [controller] = await once(server, "connection") as [net.Socket];
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const lines = async (count: number) => {
    const deadline = Date.now() + 3000;
    while (output.split("\n").filter(Boolean).length < count) {
      assert(Date.now() < deadline, `expected ${count} lines, got ${JSON.stringify(output)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return output.split("\n").filter(Boolean).map(line => JSON.parse(line));
  };
  return { child, controller, lines, async close() {
    child.kill("SIGKILL");
    server.close();
    await rm(root, { recursive: true, force: true });
  } };
}

test("tombstone answers every request id, including 0, with split UTF-8 input", async () => {
  const f = await attachedShim();
  try {
    f.controller.destroy();
    assert.equal((await f.lines(1))[0].type, "process_exit");
    const frame = Buffer.from('{"id":0,"type":"prompt","message":"\u00e9"}\n{"id":"b","type":"get_state"}\n');
    const split = frame.indexOf(Buffer.from("\u00e9")) + 1;
    f.child.stdin.write(frame.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 20));
    f.child.stdin.write(frame.subarray(split));
    const [, first, second] = await f.lines(3);
    assert.deepEqual([first.id, first.command, first.success], [0, "prompt", false]);
    assert.deepEqual([second.id, second.command], ["b", "get_state"]);
  } finally { await f.close(); }
});

test("the shim exits once both Paseo and the terminal controller have closed", async () => {
  const f = await attachedShim();
  try {
    const exited = once(f.child, "exit");
    f.child.stdin.end();
    await once(f.controller, "end");
    f.controller.destroy();
    const timer = setTimeout(() => f.child.kill("SIGKILL"), 3000);
    const [code, signal] = await exited;
    clearTimeout(timer);
    assert.deepEqual([code, signal], [0, null]);
  } finally { await f.close(); }
});
