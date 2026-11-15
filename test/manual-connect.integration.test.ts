import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const piBin = process.env.TEST_PI_BIN;

// A fake Paseo CLI whose first import fails, as when the daemon is still starting.
const fakePaseo = `#!/bin/sh
echo "$*" >> "$FAKE_PASEO_CALLS"
if [ "$1" = "import" ]; then
  if [ -e "$FAKE_PASEO_CALLS.failed" ]; then echo '{"agentId":"fixture-agent"}'; exit 0; fi
  : > "$FAKE_PASEO_CALLS.failed"
  echo '{"error":{"code":"DAEMON_UNAVAILABLE"}}'; exit 1
fi
exit 1
`;

test("manual connect with auto-connect off retries a failed import and reports the Paseo CLI", {
  skip: !piBin || process.platform === "win32", timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-manual-connect-"));
  const session = join(root, "session.jsonl");
  const runtime = join(root, "runtime");
  const agentDir = join(root, "agent");
  const cli = join(root, "paseo");
  const calls = join(root, "calls.log");
  await mkdir(runtime);
  await mkdir(join(agentDir, "paseo-bridge"), { recursive: true });
  await writeFile(join(agentDir, "paseo-bridge", "settings.json"), JSON.stringify({ auto: false }));
  await writeFile(cli, fakePaseo);
  await chmod(cli, 0o755);
  await writeFile(session, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: root }) + "\n");
  const child = spawn(piBin!, ["--offline", "--mode", "rpc", "--session", session, "--no-extensions", "--no-skills", "--no-prompt-templates", "--extension", resolve("extension/index.ts")], {
    cwd: root,
    env: { ...process.env, HOME: root, XDG_RUNTIME_DIR: runtime, PI_CODING_AGENT_DIR: agentDir,
      PI_PASEO_BRIDGE: "on", PI_PASEO_BRIDGE_FORCE: "1", PI_PASEO_BRIDGE_NO_IMPORT: "", PI_PASEO_BRIDGE_IMPORT_SESSIONS: "1",
      PASEO_CLI: cli, PASEO_HOST: "fixture://offline", FAKE_PASEO_CALLS: calls,
      PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const frames: any[] = [];
  let buffer = "";
  child.stdout.on("data", data => {
    buffer += data.toString();
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      try { frames.push(JSON.parse(buffer.slice(0, newline))); } catch { /* not a frame */ }
      buffer = buffer.slice(newline + 1);
    }
  });
  const exited = once(child, "close");
  const until = async <T>(read: () => Promise<T | undefined> | T | undefined, description: string, timeoutMs = 10000): Promise<T> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      assert(child.exitCode === null && Date.now() < end, `${description}: ${stderr}\n${JSON.stringify(frames)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const command = async (id: string, message: string) => {
    child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
    const response = await until(() => frames.find(frame => frame.type === "response" && frame.id === id), `${message} must finish`);
    assert.equal(response.success, true, JSON.stringify(response));
  };
  try {
    await command("connect", "/paseo-bridge connect");
    const agentId = await until(async () => {
      try { return JSON.parse(await readFile(join(root, ".pi", "paseo-bridge", "agents.json"), "utf8"))[session]; }
      catch { return undefined; }
    }, "the failed import must be retried");
    assert.equal(agentId, "fixture-agent");
    const imports = (await readFile(calls, "utf8")).split("\n").filter(line => line.startsWith("import "));
    assert.equal(imports.length, 2);
    await command("status", "/paseo-bridge status");
    const status = await until(() => frames.find(frame => frame.method === "notify" && frame.message?.startsWith("Paseo bridge status")), "status must be reported");
    assert.match(status.message, new RegExp(`paseo CLI: ${cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(status.message, /bridged as Paseo agent fixture-agent/);
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 3000);
    try { await exited; } finally { clearTimeout(timer); await rm(root, { recursive: true, force: true }); }
  }
});
