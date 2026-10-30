import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const executable = process.env.BRIDGE_NATIVE_PI;
const providerEntry = process.env.BRIDGE_STOCK_PASEO_PI_PROVIDER;
const paseoCli = process.env.PASEO_CLI;
const root = fileURLToPath(new URL("../", import.meta.url));


test("stock Paseo questions deliver each decision once to the original Pi callback", {
  skip: !executable || !providerEntry || !paseoCli,
  timeout: 45_000,
}, async t => {
  const providerUrl = pathToFileURL(await realpath(providerEntry!));
  const hostPackage = JSON.parse(await readFile(new URL("../../../../../../package.json", providerUrl), "utf8"));
  assert.equal(hostPackage.name, "@getpaseo/server");
  assert.equal(hostPackage.version, "0.13.0", "this proof targets the published stock host release");
  const { PiRpcAgentClient } = await import(providerUrl.href);
  const {createPaseoDaemon} = await import(new URL("../../../exports.js", providerUrl).href);
  const { PiCliRuntime } = await import(new URL("cli-runtime.js", providerUrl).href);
  const require = createRequire(providerUrl);
  const sdkPath = await realpath(process.env.BRIDGE_PI_SDK ?? fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const sdkVersion = JSON.parse(await readFile(new URL("../package.json", pathToFileURL(sdkPath)), "utf8")).version;
  const logger = require("pino")({ level: "silent" });
  const {createHostClient} = await import(pathToFileURL(require.resolve("@getpaseo/client/node")).href);
  const temporary = await mkdtemp(path.join(tmpdir(), "pdia-"));
  const home = path.join(temporary, "home"), cwd = path.join(temporary, "cwd"), runtime = path.join(temporary, "run");
  const agent = path.join(home, ".pi", "agent"), sessionFile = path.join(temporary, "session.jsonl");
  const readyFile = path.join(temporary, "ready"), receiptFile = path.join(temporary, "receipts.jsonl");
  const releaseFile = path.join(temporary, "release"), paseoHome = path.join(temporary, "paseo");
  await Promise.all([home, cwd, runtime, agent].map(directory => mkdir(directory, { recursive: true })));
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ packages: [], autoCompact: false }));
  const isolatedEnv = {
    PATH: [path.dirname(executable!), path.dirname(process.execPath)].join(path.delimiter),
    HOME: home, TMPDIR: temporary, XDG_RUNTIME_DIR: runtime,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"), PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    PASEO_CLI: paseoCli!, PASEO_HOME: paseoHome, PASEO_HOST: "",
    DIALOG_READY_FILE: readyFile, DIALOG_RECEIPT_FILE: receiptFile, DIALOG_RELEASE_FILE: releaseFile,
    DIALOG_SESSION_FILE: sessionFile, BRIDGE_NATIVE_EXTENSION: process.env.BRIDGE_NATIVE_EXTENSION ?? path.join(root, "extension/index.ts"),
    BRIDGE_PI_SDK: sdkPath,
  };
  let gatedRequestId: string | undefined;
  const heldResponses: Array<() => void> = [];
  const runtimeClient = new PiCliRuntime({
    logger, command: [process.execPath, path.join(root, "shim/pi-paseo-shim.js")], requestTimeoutMs: 5000,
    spawnProcess: (launch: any) => {
      const child = spawn(launch.argv[0], launch.argv.slice(1), { cwd, env: isolatedEnv, stdio: ["pipe", "pipe", "pipe"] });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((...args: Parameters<typeof write>) => {
        const frame = JSON.parse(String(args[0]));
        if (frame.type === "extension_ui_response" && frame.id === gatedRequestId) {
          assert.equal(heldResponses.length, 0, "only the selected response may be held");
          heldResponses.push(() => write(...args));
          return true;
        }
        return write(...args);
      }) as typeof child.stdin.write;
      return child;
    },
  });
  const daemon = await createPaseoDaemon({
    listen: "127.0.0.1:0", paseoHome, daemonVersion: "0.13.0", corsAllowedOrigins: [], hostnames: true,
    mcpEnabled: false, browserToolsEnabled: false, staticDir: cwd, mcpDebug: false,
    agentClients: {pi: new PiRpcAgentClient({logger, runtime: runtimeClient})},
    agentStoragePath: path.join(paseoHome, "agents"), relayEnabled: false, pluginsEnabled: false,
  }, logger);
  await daemon.start();
  const address = daemon.getListenTarget();
  assert.equal(address?.type, "tcp");
  const daemonAddress = '127.0.0.1:' + address.port;
  const {WebSocket, WebSocketServer} = require("ws");
  const acknowledgements = new Set<string>();
  const proxySockets = new Set<any>();
  const networkErrors: Error[] = [];
  const proxy = new WebSocketServer({host: "127.0.0.1", port: 0});
  proxy.on("connection", (incoming: any) => {
    const outgoing = new WebSocket('ws://' + daemonAddress + '/ws');
    proxySockets.add(incoming); proxySockets.add(outgoing);
    const pending: any[] = [];
    incoming.on("message", (data: any) => {
      if (outgoing.readyState === WebSocket.OPEN) outgoing.send(data, {binary: false});
      else { assert.ok(pending.length < 16, "fixture proxy admission queue is bounded"); pending.push(data); }
    });
    outgoing.on("open", () => { for (const data of pending.splice(0)) outgoing.send(data, {binary: false}); });
    outgoing.on("message", (data: any) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "session" && frame.message?.type === "agent_permission_resolved") acknowledgements.add(frame.message.payload.requestId);
      incoming.send(data, {binary: false});
    });
    incoming.on("error", (error: Error) => networkErrors.push(error));
    outgoing.on("error", (error: Error) => networkErrors.push(error));
    incoming.on("close", () => { proxySockets.delete(incoming); outgoing.close(); });
    outgoing.on("close", () => { proxySockets.delete(outgoing); incoming.close(); });
  });
  await once(proxy, "listening");
  isolatedEnv.PASEO_HOST = '127.0.0.1:' + proxy.address().port;
  const client = createHostClient(daemonAddress, {clientId: "pi-dialog-contract", clientType: "cli", reconnect: {enabled: false}});
  await client.connect();
  const child = spawn(process.execPath, ["--experimental-strip-types", path.join(root, "test/fixtures/stock-dialog-session.mjs")],
    {cwd, env: isolatedEnv, stdio: ["pipe", "pipe", "pipe"]});
  let stderr = "", stdout = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
  const nativeReplies = new Map<string, any>();
  child.stdout.on("data", chunk => {
    stdout += chunk.toString();
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      const frame = JSON.parse(line);
      if (frame.type === "response") nativeReplies.set(frame.id, frame);
    }
  });
  const childExit = once(child, "exit");
  let agentId: string;
  let hostSession: any;
  async function until<T>(read: () => Promise<T | undefined> | T | undefined, description: string): Promise<T> {
    const deadline = Date.now() + 5000;
    for (;;) {
      assert.equal(child.exitCode, null, `Pi exited: ${stderr}`);
      assert.deepEqual(networkErrors, [], "fixture network must remain healthy");
      const value = await read();
      if (value !== undefined) return value;
      assert.ok(Date.now() < deadline, `${description}; Pi stderr: ${stderr}`);
      await delay(10);
    }
  }
  const receipts = async () => {
    try { return (await readFile(receiptFile, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  try {
    const socketPath = path.join(runtime, "pi-paseo", createHash("sha256").update(sessionFile).digest("hex").slice(0, 20) + ".sock");
    await until(async () => {
      try { await Promise.all([access(readyFile), access(socketPath)]); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    }, "production bridge socket must become ready");
    agentId = await until(async () => {
      try { return JSON.parse(await readFile(path.join(home, ".pi/paseo-bridge/agents.json"), "utf8"))[sessionFile]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    }, "real Paseo CLI import must establish the production agent identity");
    hostSession = daemon.agentManager.getAgent(agentId)?.session;
    assert.ok(hostSession, "daemon must retain the actual imported Pi provider session");
    const cases = [
      { method: "select", key: "selected", response: { behavior: "allow", updatedInput: { answers: { Response: "Two" } } }, expected: "Two" },
      { method: "input", key: "input", response: { behavior: "allow", updatedInput: { answers: { Response: "literal backend value" } } }, expected: "literal backend value" },
      { method: "confirm", key: "confirmed", response: { behavior: "allow", updatedInput: { answers: { Response: "Yes" } } }, expected: true },
      { method: "confirm", key: "declined", response: { behavior: "allow", updatedInput: { answers: { Response: "No" } } }, expected: false },
      { method: "input", key: "cancelled", response: { behavior: "deny" }, expected: null },
    ];
    for (const [index, scenario] of cases.entries()) {
      const commandId = `fixture-${index}`;
      child.stdin.write(JSON.stringify({ type: "prompt", id: commandId, message: `/stock-dialog ${scenario.method} ${scenario.key}` }) + "\n");
      const question: any = await until(() => hostSession.getPendingPermissions()[0], "stock host must publish a native question");
      assert.equal(question.kind, "question");
      assert.equal(question.metadata.extensionUiMethod, scenario.method);
      assert.equal(question.input.questions[0].header, "Response");
      if (scenario.method === "select") assert.deepEqual(question.input.questions[0].options.map((option: any) => option.label), ["One", "Two"]);
      await client.respondToPermissionAndWait(agentId, question.id, scenario.response);
      const receipt: any = await until(async () => (await receipts()).find(value => value.key === scenario.key), "response must reach the original Pi callback");
      assert.deepEqual(receipt, { key: scenario.key, method: scenario.method, value: scenario.expected });
      const nativeReply: any = await until(() => nativeReplies.get(commandId), "original Pi command must finish");
      assert.equal(nativeReply.success, true, JSON.stringify(nativeReply));
      assert.deepEqual(hostSession.getPendingPermissions(), []);
      if (index === 0) {
        await assert.rejects(client.respondToPermissionAndWait(agentId, question.id, scenario.response), /No pending permission/);
        assert.deepEqual(await receipts(), [{key: "disconnected", method: "select", value: "One"}, receipt], "late and duplicate answers must not resume the callback twice");
      }
    }
    for (const scenario of [
      {method: "local", expected: "One"},
      {method: "race", expected: "Two"},
      {method: "abort", expected: null},
      {method: "timeout", expected: null},
      {method: "stop", expected: null},
    ]) {
      await rm(releaseFile, {force: true});
      const key = scenario.method, commandId = 'fixture-' + key;
      child.stdin.write(JSON.stringify({type: "prompt", id: commandId, message: '/stock-dialog ' + key + ' ' + key}) + "\n");
      const question: any = await until(() => hostSession.getPendingPermissions()[0], "native sidechannel fixture must publish a question");
      if (key === "local" || key === "timeout") gatedRequestId = question.id;
      const competing = key === "race"
        ? client.respondToPermissionAndWait(agentId, question.id, {behavior: "allow", updatedInput: {answers: {Response: "Two"}}})
        : undefined;
      if (competing) await competing;
      if (key === "stop") await hostSession.interrupt();
      else await writeFile(releaseFile, "release");
      if (key === "local") {
        await until(() => heldResponses.length === 1 ? true : undefined, "stock provider must dispatch the selected controller response");
        await until(() => acknowledgements.has(question.id) ? true : undefined, "real daemon acknowledgement must reach the original Pi process");
        // Flush a later native event after the WebSocket acknowledgement. The
        // callback must still wait while its actual controller reply is held.
        const barrierId = "acknowledgement-barrier";
        child.stdin.write(JSON.stringify({type: "get_state", id: barrierId}) + "\n");
        await until(() => nativeReplies.get(barrierId), "native barrier must finish");
        assert.equal((await receipts()).some(value => value.key === key), false, "daemon acknowledgement is not backend dialog consumption");
        assert.equal(nativeReplies.has(commandId), false);
        gatedRequestId = undefined;
        heldResponses.shift()!();
      }
      if (key === "timeout") {
        await until(() => heldResponses.length === 1 ? true : undefined, "terminal decision must be dispatched before its controller reply is delayed");
      }
      const receipt: any = await until(async () => (await receipts()).find(value => value.key === key), `${key}: native daemon response must reach the original mirrored callback`);
      assert.deepEqual(receipt, {key, method: key, value: scenario.expected});
      if (key === "timeout") {
        gatedRequestId = undefined;
        heldResponses.shift()!();
      }
      assert.equal((await until(() => nativeReplies.get(commandId), "mirrored command must finish")).success, true);
      await until(() => hostSession.getPendingPermissions().length === 0 ? true : undefined, "daemon must remove the resolved or cancelled question");
      await until(() => {
        const agent = daemon.agentManager.getAgent(agentId);
        return agent?.pendingPermissions.size === 0 && !agent.inFlightPermissionResponses.has(question.id) ? true : undefined;
      }, "daemon cancellation must finish processing, not merely hide its question");
      await assert.rejects(client.respondToPermissionAndWait(agentId, question.id, {behavior: "allow", updatedInput: {answers: {Response: "LATE"}}}), /No pending permission/);
      assert.equal((await receipts()).filter(value => value.key === key).length, 1);
    }
    await rm(releaseFile, {force: true});
    child.stdin.write(JSON.stringify({type: "prompt", id: "before-reload", message: "/stock-dialog select before-reload"}) + "\n");
    const beforeReload: any = await until(() => hostSession.getPendingPermissions()[0], "pre-reload dialog must be visible");
    child.stdin.write(JSON.stringify({type: "reload", id: "reload-fixture"}) + "\n");
    await until(() => nativeReplies.get("reload-fixture"), "stock SDK must reload its real extension runtime");
    const cancelled: any = await until(async () => (await receipts()).find(value => value.key === "before-reload"), "reload must settle the old caller");
    assert.equal(cancelled.value, null);
    await until(() => hostSession.getPendingPermissions().length === 0 ? true : undefined, "reload must dismiss the old native question");
    await assert.rejects(client.respondToPermissionAndWait(agentId, beforeReload.id, {behavior: "allow", updatedInput: {answers: {Response: "LATE"}}}), /No pending permission|already being submitted/);
    child.stdin.write(JSON.stringify({type: "prompt", id: "after-reload", message: "/stock-dialog select after-reload"}) + "\n");
    const rebound: any = await until(() => hostSession.getPendingPermissions()[0], "ordinary UI must be mirrored again after reload");
    await client.respondToPermissionAndWait(agentId, rebound.id, {behavior: "allow", updatedInput: {answers: {Response: "Two"}}});
    const restored: any = await until(async () => (await receipts()).find(value => value.key === "after-reload"), "rebound dialog must reach its new caller");
    assert.equal(restored.value, "Two");
    assert.equal((await receipts()).length, cases.length + 8);

    t.diagnostic(`Pi SDK ${sdkVersion} TUI binding (controlled terminal renderer), Paseo ${hostPackage.version}: ordinary dialogs, controller echo, local/remote winners, abort/timeout/Stop, reload and disconnected-local UI passed.`);
  } finally {
    await client.close();
    for (const socket of proxySockets) socket.terminate();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await daemon.stop();
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    try { await childExit; } finally { clearTimeout(timer); await rm(temporary, { recursive: true, force: true }); }
  }
});
