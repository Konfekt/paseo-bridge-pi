import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { assertNoLiveRuntimeOwner, matchingRuntimeRecords, processStartToken, readRuntimeRecords, runtimeOwnerMayBeAlive } from "../shim/runtime-registry.js";

const record = { sessionFile: "/project/session.jsonl", agentId: "agent", pid: 123, processStartToken: "boot:1" };
test("live owner blocks fallback; missing/reused process permits it", () => {
  const live = { records: [record], kill() {}, processStartToken: () => "boot:1" };
  assert.throws(() => assertNoLiveRuntimeOwner(record.sessionFile, live), /Refusing to launch a second Pi/);
  assert.doesNotThrow(() => assertNoLiveRuntimeOwner(record.sessionFile, { ...live, ignorePid: 123 }));
  assert.doesNotThrow(() => assertNoLiveRuntimeOwner(record.sessionFile, { ...live, processStartToken: () => "boot:2" }));
  assert.doesNotThrow(() => assertNoLiveRuntimeOwner(record.sessionFile, { ...live, kill() { throw Object.assign(new Error(), { code: "ESRCH" }); } }));
});
test("unknown identity and permission failure are conservative", () => {
  assert.equal(runtimeOwnerMayBeAlive(record, { kill() { throw Object.assign(new Error(), { code: "EPERM" }); } }), true);
  assert.equal(runtimeOwnerMayBeAlive({ pid: 0 }), true);
  assert.equal(runtimeOwnerMayBeAlive(record, { kill() {}, processStartToken: () => null }), true);
  assert.equal(runtimeOwnerMayBeAlive({ pid: 123 }, { kill() {}, processStartToken: () => "new" }), true);
});
test("discovery matches agent alias or canonical path", () => {
  assert.deepEqual(matchingRuntimeRecords("/project/./session.jsonl", null, [record]), [record]);
  assert.deepEqual(matchingRuntimeRecords("/different", "agent", [record]), [record]);
  assert.deepEqual(matchingRuntimeRecords("/different", "other", [record]), []);
});
test("shim fails closed with a live owner and unavailable socket without spawning Pi", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-owner-test-"));
  try {
    const directory = path.join(home, ".pi", "paseo-bridge", "runtimes");
    fs.mkdirSync(directory, { recursive: true });
    const sessionFile = path.join(home, "session.jsonl");
    fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ sessionFile, pid: process.pid,
      bridgeSocket: path.join(home, "missing.sock") }));
    const shim = fileURLToPath(new URL("../shim/pi-paseo-shim.js", import.meta.url));
    const result = spawnSync(process.execPath, [shim, "--mode", "rpc", "--session", sessionFile], {
      env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home, PI_REAL_BIN: "/must-not-be-launched", PASEO_AGENT_ID: "" },
      input: "", encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Refusing to launch a second Pi/);
    assert.doesNotMatch(result.stderr, /failed to spawn/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
test("Linux process identity includes boot and process start", () => {
  if (process.platform === "linux") assert.match(processStartToken()!, /^[a-f0-9-]+:\d+$/);
});

test("unattached shim forwards native RPC and closes its owned Pi child on controller EOF", { timeout: 10000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-native-rpc-"));
  const nativePi = path.join(home, "pi.mjs");
  fs.writeFileSync(nativePi, `import { createInterface } from "node:readline";
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  console.log(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true,
    data: { source: "native-pi", pid: process.pid, argv: process.argv.slice(2) } }));
});
`);
  const shim = fileURLToPath(new URL("../shim/pi-paseo-shim.js", import.meta.url));
  const args = ["--mode", "rpc", "--session", path.join(home, "session.jsonl")];
  const child = spawn(process.execPath, [shim, ...args], {
    env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home, PI_REAL_BIN: nativePi, PASEO_AGENT_ID: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nativePid: number | undefined;
  t.after(() => {
    child.kill("SIGKILL");
    if (nativePid) { try { process.kill(nativePid, "SIGKILL"); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout });
  const response = once(lines, "line");
  child.stdin.write('{"id":"state","type":"get_state"}\n');
  const [line] = await response;
  const reply = JSON.parse(line);
  assert.equal(reply.id, "state");
  assert.equal(reply.command, "get_state");
  assert.equal(reply.success, true);
  assert.equal(reply.data.source, "native-pi");
  assert.deepEqual(reply.data.argv, args);
  nativePid = reply.data.pid;
  const closed = once(child, "close");
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0);
  assert.throws(() => process.kill(nativePid!, 0), { code: "ESRCH" });
  nativePid = undefined;
});

test("invalid persisted ownership is not treated as permission to launch another writer", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-invalid-owner-"));
  try {
    fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ pid: process.pid, bridgeSocket: "/missing.sock" }));
    assert.throws(() => readRuntimeRecords(directory), /Invalid Pi runtime registry record/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
