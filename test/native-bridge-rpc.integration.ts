import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// The executable is supplied by native-rpc-check.nix, never a user wrapper.
// Model streams are forbidden; the ordinary fixture prompt is consumed by input.
const executable = process.env.BRIDGE_NATIVE_PI;
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureProvider = `import { appendFileSync, writeFileSync } from "node:fs";
export default function(pi) {
  pi.on("session_start", event => appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, event.reason + "\\n"));
  pi.on("agent_start", () => appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "AGENT_STARTED\\n"));
  pi.on("input", event => {
    if (event.text !== "ordinary offline bridge provenance fixture") return;
    writeFileSync(process.env.OFFLINE_INPUT_RECEIPT, JSON.stringify({
      source: event.source,
      streamingBehavior: event.streamingBehavior ?? null,
      streamingBehaviorIsUndefined: event.streamingBehavior === undefined,
    }));
    return { action: "handled" };
  });
  pi.registerProvider("bridge-offline", {
    api: "bridge-offline-never-stream", baseUrl: "http://127.0.0.1:1",
    apiKey: "offline-fixture-not-a-secret",
    streamSimple() {
      appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "PROVIDER_CALLED\\n");
      throw new Error("OFFLINE TEST MUST NOT CALL PROVIDERS");
    },
    models: ["first", "second"].map(id => ({ id, name: id, reasoning: true,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768, maxTokens: 1024 }))
  });
  pi.registerCommand("offline-fixture-command", { description: "metadata only", handler: async () => {} });
}`;

function rpc(stream: Socket | NodeJS.ReadableStream, write: (line: string) => void) {
  let next = 0, buffer = "";
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  stream.on("data", chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== "response") continue;
      const waiter = pending.get(record.id);
      if (waiter) { pending.delete(record.id); waiter.resolve(record); }
    }
  });
  return async (type: string, fields: Record<string, unknown> = {}) => {
    const id = `native-${++next}`;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise<any>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 4000);
        write(JSON.stringify({ ...fields, id, type }) + "\n");
      });
    } finally { clearTimeout(timer!); pending.delete(id); }
  };
}

test("actual Pi executable and production bridge RPC", { skip: !executable, timeout: 45000 }, async t => {
  // Short path also fits Unix sockaddr_un in Nix build directories.
  const temporary = await mkdtemp(path.join(tmpdir(), "brpc-"));
  const home = path.join(temporary, "home"), cwd = path.join(temporary, "cwd");
  const runtime = path.join(temporary, "run"), agent = path.join(home, ".pi", "agent");
  await Promise.all([home, cwd, runtime, agent].map(p => mkdir(p, { recursive: true })));
  const provider = path.join(temporary, "provider.ts");
  await writeFile(provider, fixtureProvider);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({
    defaultProvider: "bridge-offline", defaultModel: "first", defaultThinkingLevel: "low",
    packages: [], autoCompact: false,
  }));
  const session = path.join(temporary, "session.jsonl");
  const socketPath = path.join(runtime, "pi-paseo", createHash("sha256").update(session).digest("hex").slice(0, 20) + ".sock");
  const bridgeEntry = process.env.BRIDGE_NATIVE_EXTENSION ?? path.join(root, "extension/index.ts");
  t.diagnostic(`Pi executable: ${executable}; bridge entry: ${bridgeEntry}`);
  const child = spawn(executable!, ["--mode", "rpc", "--session", session,
    "--no-extensions", "--extension", bridgeEntry,
    "--extension", provider, "--provider", "bridge-offline", "--model", "first", "--thinking", "low",
    "--no-skills", "--no-prompt-templates"], {
    cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
    // Allowlist only. In particular no API keys, tmux, service, auth, agent
    // sockets, user Pi configuration, or inherited wrapper environment.
    env: { PATH: path.dirname(executable!), HOME: home, TMPDIR: temporary,
      XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"), XDG_DATA_HOME: path.join(home, ".local/share"),
      OFFLINE_LIFECYCLE_FILE: path.join(temporary, "lifecycle"),
      OFFLINE_INPUT_RECEIPT: path.join(temporary, "input-receipt.json"),
      PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      PI_PASEO_BRIDGE_FORCE: "1", PI_PASEO_BRIDGE_NO_IMPORT: "1", PI_PASEO_BRIDGE_NO_TITLE: "1",
      PI_PASEO_BRIDGE_IMPORT_SESSIONS: "0", PI_PASEO_BRIDGE_GENERATE_TITLES: "0", PASEO_HOST: "fixture://offline" },
  });
  let stderr = "", startupError: Error | undefined;
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-12000); });
  child.on("error", error => { startupError = error; });
  const exited = once(child, "exit");
  const native = rpc(child.stdout, line => child.stdin.write(line));
  let socket: Socket | undefined;
  try {
    const deadline = Date.now() + 12000;
    for (;;) {
      if (startupError) throw startupError;
      assert.equal(child.exitCode, null, `Pi exited during startup: ${stderr}`);
      try {
        socket = connect(socketPath);
        await once(socket, "connect");
        break;
      } catch (error) {
        socket?.destroy();
        if (Date.now() >= deadline) throw new Error(`Bridge socket not ready: ${String(error)}\n${stderr}`);
        await delay(50);
      }
    }
    const bridge = rpc(socket, line => socket!.write(line));
    const ok = async (type: string, fields = {}) => {
      const result = await bridge(type, fields);
      assert.equal(result.command, type);
      assert.equal(result.success, true, JSON.stringify(result));
      return result.data;
    };
    await t.test("native bridge routes state and commands", async () => {
      const state = await ok("get_state");
      assert.equal(state.model.provider, "bridge-offline");
      assert.equal(state.model.id, "first");
      assert.equal(state.sessionFile, session);
      assert.equal(state.isStreaming, false);
      const { commands } = await ok("get_commands");
      assert.ok(commands.some((c: any) => c.name === "offline-fixture-command"));
      assert.ok(commands.some((c: any) => c.name === "remote-reload"));
    });
    await t.test("native bridge routes session stats", async () => {
      const stats = await ok("get_session_stats");
      const direct = await native("get_session_stats");
      assert.equal(direct.success, true);
      assert.deepEqual(stats, direct.data);
      assert.equal(stats.sessionFile, session);
      assert.ok(stats.sessionId);
      assert.equal(stats.totalMessages, 0);
      assert.deepEqual(stats.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
      assert.equal(stats.cost, 0);
    });
    await t.test("native bridge applies thinking and same-model echoes preserve it", async () => {
      await ok("set_thinking_level", { level: "high" });
      assert.equal((await ok("get_state")).thinkingLevel, "high");
      assert.equal((await native("get_state")).data.thinkingLevel, "high");
      for (let i = 0; i < 2; i++) {
        const model = await ok("set_model", { provider: "bridge-offline", modelId: "first" });
        assert.equal(model.id, "first");
        assert.equal((await ok("get_state")).thinkingLevel, "high");
      }
    });
    await t.test("native bridge changes model and invalid model preserves selection", async () => {
      const model = await ok("set_model", { provider: "bridge-offline", modelId: "second" });
      assert.equal(model.id, "second");
      const before = await ok("get_state");
      assert.equal(before.model.id, "second");
      assert.equal((await native("get_state")).data.model.id, "second");
      const failure = await bridge("set_model", { provider: "bridge-offline", modelId: "missing" });
      assert.equal(failure.command, "set_model");
      assert.equal(failure.success, false);
      assert.match(failure.error, /Model not found: bridge-offline\/missing/);
      const after = await ok("get_state");
      assert.deepEqual(after.model, before.model);
      assert.equal(after.thinkingLevel, before.thinkingLevel);
    });
    await t.test("idle bridge prompt reaches actual Pi input as extension provenance without streaming behavior", async () => {
      assert.equal((await ok("get_state")).isStreaming, false);
      const accepted = await ok("prompt", { message: "ordinary offline bridge provenance fixture" });
      assert.equal(accepted.agentInvoked, true, "bridge delegates the ordinary prompt to Pi");
      const deadline = Date.now() + 4000;
      let receipt: any;
      for (;;) {
        try { receipt = JSON.parse(await readFile(path.join(temporary, "input-receipt.json"), "utf8")); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          assert.ok(Date.now() < deadline, "Pi input handler must receive the bridge prompt");
          await delay(20);
        }
      }
      assert.deepEqual(receipt, {
        source: "extension", streamingBehavior: null, streamingBehaviorIsUndefined: true,
      });
      // Barrier behind asynchronous sendUserMessage: Pi's native abort waits
      // for idle. The fixture consumes input before any agent/model work.
      assert.equal((await native("abort")).success, true);
      assert.equal((await ok("get_state")).isStreaming, false);
      const lifecycle = await readFile(path.join(temporary, "lifecycle"), "utf8");
      assert.ok(!lifecycle.includes("AGENT_STARTED"));
      assert.ok(!lifecycle.includes("PROVIDER_CALLED"));
      assert.equal((await ok("get_session_stats")).totalMessages, 0);
    });
    await t.test("native remote-reload keeps the isolated Pi and attached bridge alive", async () => {
      const pid = child.pid;
      const before = await ok("get_state");
      const accepted = await ok("prompt", { message: "/remote-reload" });
      assert.equal(accepted.reloadAccepted, true);
      assert.equal(accepted.agentInvoked, false);
      const deadline = Date.now() + 8000;
      while (!(await readFile(path.join(temporary, "lifecycle"), "utf8")).split("\n").includes("reload")) {
        assert.ok(Date.now() < deadline, `Reload did not reach session_start: ${stderr}`);
        await delay(50);
      }
      // Lifecycle event arrives after production bridge rebind (extension order).
      const after = await ok("get_state");
      assert.equal(child.pid, pid);
      assert.equal(child.exitCode, null);
      assert.equal(socket!.destroyed, false);
      assert.equal(after.sessionId, before.sessionId);
      assert.equal(after.sessionFile, before.sessionFile);
      assert.equal(after.model.id, before.model.id);
      assert.equal((await ok("get_session_stats")).totalMessages, 0);
      assert.ok(!(await readFile(path.join(temporary, "lifecycle"), "utf8")).includes("PROVIDER_CALLED"));
    });
  } finally {
    socket?.destroy();
    child.stdin.end();
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid) try { process.kill(-child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<void>(resolve => {
        timer = setTimeout(() => { killGroup("SIGKILL"); resolve(); }, 3000);
      })]);
      if (child.exitCode === null && child.signalCode === null) await exited;
    } finally {
      clearTimeout(timer);
      killGroup("SIGKILL");
      if (child.pid) assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" }, "Pi must be reaped");
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
