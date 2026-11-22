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

// Paseo's /clone, /new and /resume replace the terminal's Pi session through
// Pi's command context. A local provider answers; no network is used.
const executable = process.env.BRIDGE_NATIVE_PI;
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export default function(pi) {
  pi.registerProvider("switch-offline", {
    api: "switch-offline-answer", baseUrl: "http://127.0.0.1:1", apiKey: "offline-fixture-not-a-secret",
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: "offline reply" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
    models: [{ id: "answer", name: "answer", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
  });
}`;

function rpc(stream: Socket | NodeJS.ReadableStream, write: (line: string) => void, events: any[] = []) {
  let next = 0, buffer = "";
  const pending = new Map<string, (value: any) => void>();
  stream.on("data", chunk => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== "response") { events.push(record); continue; }
      pending.get(record.id)?.(record);
      pending.delete(record.id);
    }
  });
  return async (type: string, fields: Record<string, unknown> = {}) => {
    const id = `switch-${++next}`;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise<any>((resolve, reject) => {
        pending.set(id, resolve);
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 6000);
        write(JSON.stringify({ ...fields, id, type }) + "\n");
      });
    } finally { clearTimeout(timer!); pending.delete(id); }
  };
}

test("Paseo's /clone, /new and /resume switch the terminal's Pi session", { skip: !executable, timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "bsw-"));
  const home = path.join(temporary, "home"), cwd = path.join(temporary, "cwd");
  const runtime = path.join(temporary, "run"), agent = path.join(home, ".pi", "agent");
  await Promise.all([home, cwd, runtime, agent].map(directory => mkdir(directory, { recursive: true })));
  const provider = path.join(temporary, "provider.ts");
  await writeFile(provider, fixture);
  const sessions = path.join(temporary, "sessions");
  const child = spawn(executable!, ["--mode", "rpc", "--session-dir", sessions,
    "--no-extensions", "--extension", process.env.BRIDGE_NATIVE_EXTENSION ?? path.join(root, "extension/index.ts"),
    "--extension", provider, "--provider", "switch-offline", "--model", "answer", "--no-skills", "--no-prompt-templates"], {
    cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: [path.dirname(executable!), path.dirname(process.execPath)].join(path.delimiter), HOME: home, TMPDIR: temporary,
      XDG_RUNTIME_DIR: runtime, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      PI_PASEO_BRIDGE_FORCE: "1", PI_PASEO_BRIDGE_NO_IMPORT: "1", PI_PASEO_BRIDGE_IMPORT_SESSIONS: "0", PASEO_HOST: "fixture://offline" },
  });
  let stderr = "";
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-8000); });
  const native = rpc(child.stdout, line => child.stdin.write(line));
  const state = async () => {
    const response = await native("get_state");
    assert.equal(response.success, true, `${JSON.stringify(response)} ${stderr}`);
    return response.data;
  };
  const waitFor = async <T>(probe: () => Promise<T | undefined>, message: string): Promise<T> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      assert.ok(Date.now() < deadline, `${message}; stderr: ${stderr}`);
      await delay(25);
    }
  };
  // The bridge serves one socket per session file.
  const attach = async () => {
    const file: string = await waitFor(async () => (await state()).sessionFile ?? undefined, "Pi has a session file");
    const pipe = path.join(runtime, "pi-paseo", createHash("sha256").update(file).digest("hex").slice(0, 20) + ".sock");
    const socket = await waitFor(async () => {
      const candidate = connect(pipe);
      try { await once(candidate, "connect"); return candidate; }
      catch { candidate.destroy(); return undefined; }
    }, `the bridge listens for ${file}`);
    const events: any[] = [];
    const call = rpc(socket, line => socket.write(line), events);
    const outputs = () => events.filter(event => event.type === "command_output").map(event => event.text).join("\n");
    return { file, socket, call, outputs };
  };
  const leaves = (file: string) => waitFor(async () => {
    const next = (await state()).sessionFile;
    return next && next !== file ? next as string : undefined;
  }, `the terminal leaves ${file}`);
  const saved = (file: string, pattern: RegExp) => waitFor(async () => {
    const text = await readFile(file, "utf8").catch(() => "");
    return pattern.test(text) ? text : undefined;
  }, `${file} saves ${pattern}`);
  try {
    assert.equal((await native("prompt", { message: "the original first prompt" })).success, true);
    const first = await attach();
    await saved(first.file, /the original first prompt[\s\S]*offline reply/);

    const clone = await first.call("prompt", { message: "/clone" });
    assert.equal(clone.success, true, JSON.stringify(clone));
    assert.equal(clone.data.agentInvoked, false);
    assert.match(first.outputs(), /Cloning this session/);
    const cloned = await leaves(first.file);
    await saved(cloned, /the original first prompt[\s\S]*offline reply/);
    first.socket.destroy();

    const copy = await attach();
    assert.equal(copy.file, cloned);
    const usage = await copy.call("prompt", { message: "/new" });
    assert.match(usage.error, /Usage: \/new <first prompt>/);
    const fresh = await copy.call("prompt", { message: "/new start the next task" });
    assert.equal(fresh.success, true, JSON.stringify(fresh));
    assert.match(copy.outputs(), /Starting a new Pi session/);
    const created = await leaves(cloned);
    const createdText = await saved(created, /start the next task[\s\S]*offline reply/);
    assert.doesNotMatch(createdText, /the original first prompt/);
    copy.socket.destroy();

    const current = await attach();
    const listing = await current.call("prompt", { message: "/resume" });
    assert.equal(listing.success, true, JSON.stringify(listing));
    assert.match(current.outputs(), /Recent Pi sessions in this folder:\n1\. start the next task \(current\)/);
    const firstId = JSON.parse((await readFile(first.file, "utf8")).split("\n")[0]).id;
    const already = await current.call("prompt", { message: "/resume 1" });
    assert.equal(already.success, true);
    assert.match(current.outputs(), /already in that session/);
    const resume = await current.call("prompt", { message: `/resume ${firstId}` });
    assert.equal(resume.success, true, JSON.stringify(resume));
    assert.equal(await leaves(created), first.file);
    current.socket.destroy();
  } finally {
    child.stdin.end();
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
    await rm(temporary, { recursive: true, force: true });
  }
});
