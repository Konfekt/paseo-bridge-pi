import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { once } from "node:events";
import { callHarnessReadOnly } from "../plugin/server/harness-readonly-transport.ts";

const piBin = process.env.TEST_PI_BIN;
test("real Pi/Bun reload replaces a cached legacy accept callback, retains provider and serves500unicode messages", { skip: !piBin, timeout: 40000 }, async () => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "readonly-actual-pi-reload-"));
  const old = join(root, "old-package"), fresh = join(root, "new-package"), agent = join(root, "agent");
  let child: ReturnType<typeof spawn> | undefined, controller: net.Socket | undefined, stderr = "";
  const eventTypes: string[] = [];
  const fixture = `import {writeFileSync,chmodSync} from 'node:fs';
import {BridgeTransport,retainBridgeForReload,takeBridgeAfterReload} from './extension/bridge-transport.js';
export default function(pi){process.umask(0o022);let t;
pi.on('session_start',()=>{t=takeBridgeAfterReload('fixture-session')?.transport??new BridgeTransport('fixture-session',process.env.FIXTURE_SOCKET);
t.bind({command:async()=>{},attached(){},detached(){},error(){},harnessReadOnly:async q=>{if(q.runtimeEpoch!==t.operatorEpoch||q.capability!==t.harnessReadOnlyCapability)throw Error('stale');return {sessionId:'fixture-session',messages:Array.from({length:500},(_,i)=>({id:i,text:'🌍'.repeat(150)}))};}});
if(!t.connected)t.start();if(import.meta.url.includes('/old-package/'))chmodSync(t.harnessReadOnlySocketPath,0o600);
writeFileSync(process.env.FIXTURE_DESCRIPTOR,JSON.stringify({version:1,socketPath:t.harnessReadOnlySocketPath,capability:t.harnessReadOnlyCapability,agentId:'fixture-agent',sessionId:'fixture-session',runtimeEpoch:t.operatorEpoch,entry:import.meta.url}),{mode:0o600});});
pi.on('session_shutdown',()=>retainBridgeForReload(t,'fixture-agent',false));
pi.registerCommand('fixture-reload',{handler:async(_args,ctx)=>{await ctx.reload();}});}`;
  async function until<T>(fn: () => Promise<T>, predicate: (v: T) => boolean): Promise<T> {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      try { const value = await fn(); if (predicate(value)) return value; } catch {}
      assert(child?.exitCode === null, `fixture exited: ${stderr.slice(-400)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Fixture deadline: ${stderr.slice(-400)}`);
  }
  try {
    for (const directory of [old, fresh]) {
      await mkdir(directory, { recursive: true });
      for (const name of ["extension", "shim"]) await cp(join(repository, name), join(directory, name), { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module", pi: { extensions: ["./fixture.ts"] } }));
      await writeFile(join(directory, "fixture.ts"), fixture);
    }
    // Self-contained legacy module: capture the old handler in createServer's
    // callback, just like the pre-dynamic production implementation. Bun keeps
    // that callback even after EventEmitter removeAllListeners/on replacement.
    let legacy = await readFile(join(old, "extension/bridge-transport.ts"), "utf8");
    const constructor = "this.readonlyServer = net.createServer(socket => this.handleReadonlyConnection(socket));";
    assert.ok(legacy.includes(constructor));
    legacy = legacy.replace(constructor, "const legacyHandler = this.handleReadonlyConnection.bind(this); this.readonlyServer = net.createServer(socket => legacyHandler(socket));")
      .replace("private readonlyEndpointVersion = 2;", "private readonlyEndpointVersion: number | undefined = undefined;")
      .replace(".harness-readonly-v2", ".harness-readonly")
      .replace('if (request.method === "subagents.conversation") responseLimit = 768 * 1024;', "");
    await writeFile(join(old, "extension/bridge-transport.ts"), legacy);
    await mkdir(agent); await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [old] }));
    const descriptorFile = join(root, "descriptor.json"), socket = join(root, "provider.sock");
    child = spawn(piBin!, ["--mode", "rpc", "--session", join(root, "session.jsonl")], {
      cwd: root, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PI_TELEMETRY: "0", FIXTURE_SOCKET: socket, FIXTURE_DESCRIPTOR: descriptorFile }, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr!.on("data", data => { stderr += data.toString(); });
    let stdout = "";
    child.stdout!.on("data", data => { stdout += data.toString(); while (stdout.includes("\n")) { const end = stdout.indexOf("\n"), line = stdout.slice(0, end); stdout = stdout.slice(end + 1); try { eventTypes.push(JSON.parse(line).type); } catch {} } });
    const before: any = await until(async () => JSON.parse(await readFile(descriptorFile, "utf8")), () => true);
    controller = net.connect(socket); await once(controller, "connect");
    await until(async () => (await stat(before.socketPath)).mode & 0o777, mode => mode === 0o600);
    await assert.rejects(callHarnessReadOnly(before, "subagents.conversation", {}), /Oversized read-only result/);
    const pid = child.pid;
    await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [fresh] }));
    child.stdin!.write(JSON.stringify({ id: "fixture-reload", type: "prompt", message: "/fixture-reload" }) + "\n");
    const after: any = await until(async () => JSON.parse(await readFile(descriptorFile, "utf8")), value => value.runtimeEpoch !== before.runtimeEpoch);
    assert.match(after.entry, /new-package/);
    assert.notEqual(after.socketPath, before.socketPath);
    assert.equal((await stat(after.socketPath)).mode & 0o777, 0o600, "private on actual Bun with umask0022, not just Node's listen callback");
    const result: any = await callHarnessReadOnly(after, "subagents.conversation", {});
    assert.equal(result.messages.length, 500);
    assert.equal(result.messages[0].text, "🌍".repeat(150));
    await assert.rejects(callHarnessReadOnly({ ...before, socketPath: after.socketPath }, "subagents.conversation", {}), /stale/);
    assert.equal(controller.destroyed, false);
    assert.equal(child.pid, pid); assert.equal(child.exitCode, null);
    assert.ok(!eventTypes.includes("agent_start"), "fixture reload never invokes a model");
  } finally {
    controller?.destroy();
    if (child && child.exitCode === null) {
      child.stdin!.end(); const done = once(child, "close");
      const timer = setTimeout(() => child!.kill("SIGTERM"), 2000);
      await done; clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  }
});
