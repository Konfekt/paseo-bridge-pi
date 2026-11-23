import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

const executable = process.env.BRIDGE_NATIVE_PI;
const providerEntry = process.env.BRIDGE_STOCK_PASEO_PI_PROVIDER;
const paseoCli = process.env.PASEO_CLI;
const root = fileURLToPath(new URL("../", import.meta.url));
const skip = !executable || !providerEntry || !paseoCli;

/**
 * An in-process stock Paseo daemon whose pi provider runs the production shim.
 * `password` protects the daemon; `selectHost: false` leaves PASEO_HOST unset,
 * so pi and the shim find the daemon as Paseo's own CLI does.
 */
async function stockPaseo(t: TestContext, options: { password?: string; selectHost?: boolean; socketOnly?: boolean; cli?: boolean } = {}) {
  const providerUrl = pathToFileURL(await realpath(providerEntry!));
  const hostPackage = JSON.parse(await readFile(new URL("../../../../../../package.json", providerUrl), "utf8"));
  assert.equal(hostPackage.name, "@getpaseo/server");
  const { PiRpcAgentClient } = await import(providerUrl.href);
  const { createPaseoDaemon } = await import(new URL("../../../exports.js", providerUrl).href);
  const { PiCliRuntime } = await import(new URL("cli-runtime.js", providerUrl).href);
  const require = createRequire(providerUrl);
  const sdkPath = await realpath(process.env.BRIDGE_PI_SDK ?? fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const logger = require("pino")({ level: "silent" });
  const { createHostClient } = await import(pathToFileURL(require.resolve("@getpaseo/client/node")).href);
  const temporary = await mkdtemp(path.join(tmpdir(), "pwks-"));
  const home = path.join(temporary, "home"), cwd = path.join(temporary, "project"), runtime = path.join(temporary, "run");
  const agentDir = path.join(home, ".pi", "agent"), paseoHome = path.join(temporary, "paseo");
  await Promise.all([home, cwd, runtime, agentDir].map(directory => mkdir(directory, { recursive: true })));
  const env: Record<string, string> = {
    PATH: [path.dirname(executable!), path.dirname(process.execPath)].join(path.delimiter),
    HOME: home, TMPDIR: temporary, XDG_RUNTIME_DIR: runtime, PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    PASEO_CLI: options.cli === false ? "" : paseoCli!, PASEO_HOME: paseoHome,
    BRIDGE_NATIVE_EXTENSION: process.env.BRIDGE_NATIVE_EXTENSION ?? path.join(root, "extension/index.ts"),
    BRIDGE_PI_SDK: sdkPath,
    DIALOG_RECEIPT_FILE: path.join(temporary, "receipts.jsonl"), DIALOG_RELEASE_FILE: path.join(temporary, "release"),
  };
  const runtimeClient = new PiCliRuntime({
    logger, command: [process.execPath, path.join(root, "shim/pi-paseo-shim.js")], requestTimeoutMs: 5000,
    spawnProcess: (launch: any) => spawn(launch.argv[0], launch.argv.slice(1), {
      cwd, env: { ...env, ...launch.env, PATH: env.PATH, HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    }),
  });
  // The stock provider checks for pi on the daemon's PATH.
  const originalPath = process.env.PATH;
  process.env.PATH = [path.dirname(executable!), originalPath].join(path.delimiter);
  const createDaemon = (listen: string) => createPaseoDaemon({
    listen, paseoHome, daemonVersion: hostPackage.version, corsAllowedOrigins: [], hostnames: true,
    mcpEnabled: false, browserToolsEnabled: false, staticDir: cwd, mcpDebug: false,
    agentClients: { pi: new PiRpcAgentClient({ logger, runtime: runtimeClient }) },
    agentStoragePath: path.join(paseoHome, "agents"), relayEnabled: false, pluginsEnabled: false,
    ...(options.password ? { auth: { password: require("bcryptjs").hashSync(options.password, 4) } } : {}),
  }, logger);
  const children: ReturnType<typeof spawn>[] = [];
  const stderr: string[] = [];
  const socketPath = path.join(temporary, "paseo.sock");
  let daemon: any = await createDaemon(options.socketOnly ? socketPath : "127.0.0.1:0");
  let client: any;
  t.after(async () => {
    for (const child of children) child.kill();
    await client?.close().catch(() => {});
    await daemon.stop?.();
    process.env.PATH = originalPath;
    await rm(temporary, { recursive: true, force: true });
  });
  let target = "";
  const connect = async () => {
    client = createHostClient(target, {
      clientId: "pi-workspaces", clientType: "cli", reconnect: { enabled: false },
      ...(options.password ? { password: options.password } : {}),
    });
    await client.connect();
  };
  // The CLI supervisor publishes the listener in the pid lock in production.
  const publishListener = () => writeFile(path.join(paseoHome, "paseo.pid"), JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname(), uid: process.getuid?.() ?? 0, listen: target,
  }));
  await daemon.start();
  const port = daemon.getListenTarget().port;
  target = options.socketOnly ? socketPath : `127.0.0.1:${port}`;
  if (options.selectHost !== false) env.PASEO_HOST = target;
  await publishListener();
  await connect();
  // Pi's own layout: per-cwd directory, timestamped files named by session UUID.
  const sessions = path.join(agentDir, "sessions", "--project--");
  await mkdir(sessions, { recursive: true });
  return {
    cwd, home, agentDir,
    get client() { return client; },
    version: hostPackage.version as string,
    sessionFile: (uuid: string) => path.join(sessions, `2026-01-01T00-00-00-000Z_${uuid}.jsonl`),
    startSession(sessionFile: string, extra: Record<string, string> = {}) {
      const child = spawn(process.execPath, ["--experimental-strip-types", path.join(root, "test/fixtures/stock-dialog-session.mjs")], {
        cwd, env: { ...env, ...extra, DIALOG_SESSION_FILE: sessionFile, DIALOG_READY_FILE: path.join(temporary, `ready-${children.length}`) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr!.on("data", chunk => stderr.push(String(chunk)));
      children.push(child);
      return child;
    },
    stderr: () => stderr.join("").slice(-2000),
    async piAgents() {
      return (await client.fetchAgents()).entries.map((entry: any) => entry.agent).filter((agent: any) => agent.provider === "pi");
    },
    async waitForPiAgents(count: number, attempts = 120) {
      let agents: any[] = [];
      for (let attempt = 0; attempt < attempts && agents.length < count; attempt += 1) {
        await delay(250);
        agents = await this.piAgents();
      }
      return agents;
    },
    /** Restart the daemon on the same port and storage; no agent is loaded afterwards. */
    async restartDaemon() {
      await client.close();
      await daemon.stop();
      daemon = await createDaemon(target);
      await daemon.start();
      await publishListener();
      await connect();
    },
  };
}

// Paseo's sidebar lists workspaces; sessions sharing a folder workspace look like one session.
test("stock Paseo shows each pi session of one folder as its own workspace", { skip, timeout: 90_000 }, async t => {
  const paseo = await stockPaseo(t);
  // A workspace another agent already opened in the same folder.
  const folderWorkspace = (await paseo.client.createWorkspace({ source: { kind: "directory", path: paseo.cwd }, title: "Folder" })).workspace?.id;
  assert.ok(folderWorkspace);
  for (const uuid of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]) {
    paseo.startSession(paseo.sessionFile(uuid));
  }
  const agents = await paseo.waitForPiAgents(2);
  assert.equal(agents.length, 2, `both sessions import; stderr: ${paseo.stderr()}`);
  const workspaceIds = agents.map(agent => agent.workspaceId);
  assert.equal(new Set([folderWorkspace, ...workspaceIds]).size, 3, `distinct workspaces: ${JSON.stringify(workspaceIds)}`);
  const workspaces = (await paseo.client.fetchWorkspaces()).entries;
  const realCwd = await realpath(paseo.cwd);
  for (const workspaceId of workspaceIds) {
    const workspace = workspaces.find((entry: any) => entry.id === workspaceId);
    assert.ok(workspace, `workspace ${workspaceId} is listed`);
    assert.equal(await realpath(workspace.workspaceDirectory ?? workspace.cwd ?? realCwd), realCwd);
  }
});

// Pi writes a new session's file only once its conversation starts, and Paseo
// 0.16 reads that file on import: importing earlier fails and leaves an empty workspace.
test("a new pi session is imported once Pi saves its first message", { skip, timeout: 90_000 }, async t => {
  const paseo = await stockPaseo(t);
  const sessionFile = paseo.sessionFile("33333333-3333-4333-8333-333333333333");
  const child = paseo.startSession(sessionFile, { DIALOG_FRESH: "1" });
  await delay(4000);
  assert.equal(existsSync(sessionFile), false, "the fixture keeps Pi's unsaved new session");
  assert.deepEqual(await paseo.piAgents(), [], `nothing is imported before the file exists; stderr: ${paseo.stderr()}`);
  assert.deepEqual((await paseo.client.fetchWorkspaces()).entries, [], "no empty workspace is left behind");
  child.stdin!.write(`${JSON.stringify({ id: "first", type: "append_user", message: "Plan the release" })}\n`);
  const agents = await paseo.waitForPiAgents(1);
  assert.equal(agents.length, 1, `the session imports after its first message; stderr: ${paseo.stderr()}`);
  const workspace = (await paseo.client.fetchWorkspaces()).entries.find((entry: any) => entry.id === agents[0].workspaceId);
  assert.equal(workspace?.title ?? workspace?.name, "Plan the release");
  const timeline = await paseo.client.fetchAgentTimeline(agents[0].id);
  assert.ok(!timeline.error, `history loads: ${JSON.stringify(timeline.error)}`);
});

// Paseo 0.16 opens a short-lived history-only session when a client reads the
// timeline of an agent it has not loaded; the live terminal must reattach afterwards.
test("reading an unloaded agent's history leaves the terminal session attached", { skip, timeout: 90_000 }, async t => {
  const paseo = await stockPaseo(t);
  const sessionFile = paseo.sessionFile("44444444-4444-4444-8444-444444444444");
  const child = paseo.startSession(sessionFile, { DIALOG_FRESH: "1", PI_PASEO_BRIDGE_DEBUG: "1" });
  child.stdin!.write(`${JSON.stringify({ id: "first", type: "append_user", message: "Keep me attached" })}\n`);
  const [agent] = await paseo.waitForPiAgents(1);
  assert.ok(agent, `the session imports; stderr: ${paseo.stderr()}`);
  await paseo.restartDaemon();
  const timeline = await paseo.client.fetchAgentTimeline(agent.id);
  assert.ok(!timeline.error, `history loads: ${JSON.stringify(timeline.error)}`);
  assert.ok(JSON.stringify(timeline.entries).includes("Keep me attached"), "history comes from the live session file");
  // Once the history-only controller leaves, the bridge asks Paseo to reload the agent.
  const debugLog = path.join(paseo.home, ".pi/paseo-bridge/debug.log");
  let log = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await delay(250);
    log = existsSync(debugLog) ? await readFile(debugLog, "utf8") : "";
    const events = log.match(/client (?:connected|disconnected)/g) ?? [];
    if (/reattach reload exited 0/.test(log) && events.at(-1) === "client connected") break;
  }
  assert.match(log, /reattach reload exited 0/, `the bridge reloads the agent; stderr: ${paseo.stderr()}`);
  assert.equal((log.match(/client (?:connected|disconnected)/g) ?? []).at(-1), "client connected", "the terminal session stays attached");
});

// A daemon on a non-default port or home, without PASEO_HOST: the bridge finds
// it as Paseo's CLI does, so the session keeps its own workspace.
test("pi finds a local daemon on a non-default port without PASEO_HOST", { skip, timeout: 90_000 }, async t => {
  const paseo = await stockPaseo(t, { selectHost: false });
  await assertImportsIntoSessionWorkspace(paseo, "55555555-5555-4555-8555-555555555555");
});

// A password-protected daemon admits its own machine's clients through the
// local credential; pi needs no PASEO_PASSWORD, as Paseo's CLI does not.
test("pi imports into its own workspace on a password-protected daemon", { skip, timeout: 90_000 }, async t => {
  const paseo = await stockPaseo(t, { password: "correct horse battery staple" });
  await assertImportsIntoSessionWorkspace(paseo, "66666666-6666-4666-8666-666666666666");
});

test("pi imports and resumes without a Paseo CLI, including after losing its agent map", { skip, timeout: 90_000 }, async t => {
  const paseo = await stockPaseo(t, { selectHost: false, cli: false });
  const sessionFile = paseo.sessionFile("77777777-7777-4777-8777-777777777777");
  let child = paseo.startSession(sessionFile, { DIALOG_FRESH: "1", PI_PASEO_BRIDGE_DEBUG: "1" });
  child.stdin!.write(`${JSON.stringify({ id: "first", type: "append_user", message: "Find the local daemon" })}\n`);
  const [first] = await paseo.waitForPiAgents(1, 40);
  assert.ok(first, `the session imports without the CLI; stderr: ${paseo.stderr()}`);
  const debugLog = path.join(paseo.home, ".pi/paseo-bridge/debug.log");
  for (const loseMap of [false, true]) {
    const exited = once(child, "close");
    child.stdin!.end();
    await exited;
    if (loseMap) await rm(path.join(paseo.home, ".pi/paseo-bridge/agents.json"));
    await writeFile(debugLog, "");
    child = paseo.startSession(sessionFile, { PI_PASEO_BRIDGE_DEBUG: "1" });
    let log = "";
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await delay(250);
      log = await readFile(debugLog, "utf8");
      if (log.includes(`paseo agent id: ${first.id} (reused)`)) break;
    }
    assert.ok(log.includes(`paseo agent id: ${first.id} (reused)`), `the saved agent reattaches without a CLI (lost map: ${loseMap}); stderr: ${paseo.stderr()}`);
    assert.deepEqual((await paseo.piAgents()).map((agent: any) => agent.id), [first.id], "resume preserves the original agent");
  }
});

test("a Unix-socket daemon gives each pi session its own workspace", {
  skip: skip || process.platform === "win32", timeout: 90_000,
}, async t => {
  const paseo = await stockPaseo(t, { selectHost: false, socketOnly: true, cli: false, password: "local socket fixture" });
  for (const uuid of ["88888888-8888-4888-8888-888888888888", "99999999-9999-4999-8999-999999999999"]) {
    paseo.startSession(paseo.sessionFile(uuid));
  }
  const agents = await paseo.waitForPiAgents(2, 40);
  assert.equal(agents.length, 2, `both sessions import over the Unix socket; stderr: ${paseo.stderr()}`);
  assert.equal(new Set(agents.map((agent: any) => agent.workspaceId)).size, 2, "sessions in the same directory have separate workspaces");
});

async function assertImportsIntoSessionWorkspace(paseo: Awaited<ReturnType<typeof stockPaseo>>, uuid: string) {
  const folderWorkspace = (await paseo.client.createWorkspace({ source: { kind: "directory", path: paseo.cwd }, title: "Folder" })).workspace?.id;
  assert.ok(folderWorkspace);
  paseo.startSession(paseo.sessionFile(uuid));
  const [agent] = await paseo.waitForPiAgents(1);
  assert.ok(agent, `the session imports; stderr: ${paseo.stderr()}`);
  assert.notEqual(agent.workspaceId, folderWorkspace, "the session gets its own workspace, not the folder fallback");
  await delay(3000);
  const agents = await paseo.piAgents();
  assert.deepEqual(agents.map((entry: any) => [entry.id, entry.workspaceId]), [[agent.id, agent.workspaceId]], "the import stays put");
  assert.ok((await paseo.client.fetchWorkspaces()).entries.some((entry: any) => entry.id === agent.workspaceId), "its workspace stays listed");
}

// Paseo's built-in slash commands: bridge-run Pi built-ins answer in the chat,
// terminal-only ones are refused, /btw answers without entering Pi's session,
// and other extensions' notifications reach Paseo while it is attached.
test("stock Paseo runs Pi built-ins, /btw and extension notices through the bridge", { skip, timeout: 90_000 }, async t => {
  const paseo = await stockPaseo(t);
  const sessionFile = paseo.sessionFile("77777777-7777-4777-8777-777777777777");
  const notifyFile = path.join(paseo.home, "terminal-notify.jsonl");
  const child = paseo.startSession(sessionFile, { DIALOG_NOTIFY_FILE: notifyFile });
  const [agent] = await paseo.waitForPiAgents(1);
  assert.ok(agent, `the session imports; stderr: ${paseo.stderr()}`);
  const commands = await paseo.client.listCommands({ agentId: agent.id });
  const names = (commands.commands ?? commands.payload?.commands ?? []).map((command: any) => command.name);
  for (const name of ["name", "model", "thinking", "session", "export", "btw", "new", "resume", "clone", "compact", "autocompact"]) {
    assert.ok(names.includes(name), `Paseo lists /${name}: ${names.join(", ")}`);
  }
  const items = async () => {
    const timeline = await paseo.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 200 });
    return (timeline.entries ?? []).map((entry: any) => entry.item ?? entry);
  };
  const run = async (text: string) => {
    await paseo.client.sendAgentMessage(agent.id, text);
    return paseo.client.waitForFinish(agent.id, 20_000);
  };
  const waitForItem = async (predicate: (item: any) => boolean, label: string) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const found = (await items()).find(predicate);
      if (found) return found;
      await delay(250);
    }
    assert.fail(`${label}: ${JSON.stringify(await items()).slice(-3000)}`);
  };
  const finished = await run("/session");
  assert.notEqual(finished.status, "error", JSON.stringify(finished));
  await waitForItem(item => item.type === "assistant_message" && /^Session info/.test(item.text), "/session answers in the chat");
  await run("/name Release plan");
  await waitForItem(item => item.type === "assistant_message" && item.text === "Session name set: Release plan", "/name answers in the chat");
  const refused = await run("/settings");
  assert.match(JSON.stringify(refused), /not available from Paseo/);
  await run("/model bridge-offline/fixture");
  await waitForItem(item => item.type === "assistant_message" && item.text === "Model set to bridge-offline/fixture.", "/model answers in the chat");
  await run("/btw what is next?");
  await waitForItem(item => item.type === "assistant_message" && item.text === "btw: what is next?\n\nfixture side answer", "/btw answers in the chat");
  const saved = await readFile(sessionFile, "utf8").catch(() => "");
  assert.doesNotMatch(saved, /what is next|fixture side answer/, "the side exchange never enters Pi's session");
  child.stdin!.write(`${JSON.stringify({ id: "notify", type: "prompt", message: "/stock-notify Build finished" })}\n`);
  await waitForItem(item => item.type === "notification" && item.message === "Build finished", "extension notices reach Paseo");
  assert.match(await readFile(notifyFile, "utf8"), /"Build finished"/, "the terminal still shows the notice");
});

// Paseo waits about two seconds for a provider to acknowledge an interrupt
// before it refuses to replace or stop the agent. A tool that keeps running
// after Stop, like a shell command still cleaning up, must not wedge the agent.
test("a new Paseo message replaces a turn whose tool ignores cancellation", { skip, timeout: 90_000 }, async t => {
  const paseo = await stockPaseo(t);
  const sessionFile = paseo.sessionFile("88888888-8888-4888-8888-888888888888");
  paseo.startSession(sessionFile, { DIALOG_SLOW_TOOL_MS: "6000" });
  const [agent] = await paseo.waitForPiAgents(1);
  assert.ok(agent, `the session imports; stderr: ${paseo.stderr()}`);
  const receipts = async () => (await readFile(path.join(paseo.home, "..", "receipts.jsonl"), "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map(line => JSON.parse(line));
  const modelInputs = async () => (await receipts()).filter(value => value.key === "model").map(value => value.value);
  const items = async () => {
    const timeline = await paseo.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 200 });
    return (timeline.entries ?? []).map((entry: any) => entry.item ?? entry);
  };
  const until = async (check: () => Promise<boolean>, label: string) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await check()) return;
      await delay(100);
    }
    assert.fail(`${label}: ${JSON.stringify(await receipts())} ${JSON.stringify(await items()).slice(-2000)}`);
  };
  await paseo.client.sendAgentMessage(agent.id, "/model bridge-offline/fixture");
  await paseo.client.waitForFinish(agent.id, 20_000);
  await paseo.client.sendAgentMessage(agent.id, "run the slow tool");
  await until(async () => (await receipts()).some(value => value.value === "started"), "the slow tool runs");
  // The app's default: a new message interrupts the running turn.
  const started = Date.now();
  await paseo.client.sendAgentMessage(agent.id, "replacement question", { activeTurnBehavior: "interrupt" });
  assert.ok(Date.now() - started < 15_000, "Paseo accepts the replacement without waiting for the tool");
  await until(async () => (await modelInputs()).some(input => input.includes("replacement question")), "the replacement turn reaches the model");
  const order = (await receipts()).map(value => value.value);
  assert.ok(order.indexOf("finished") < order.findIndex(value => String(value).includes("replacement question")),
    "the replacement starts only after Pi let the stopped tool settle");
  assert.ok(!(await modelInputs()).some(input => input.includes("slow tool output")),
    "the stopped turn does not continue after its tool");
  const finished = await paseo.client.waitForFinish(agent.id, 20_000);
  assert.notEqual(finished.status, "error", JSON.stringify(finished));
  const timeline = JSON.stringify(await items());
  assert.match(timeline, /still stopping the previous turn/, "Paseo is told that Pi is still stopping");
  assert.doesNotMatch(timeline, /System Error/, "the stopped turn's late abort does not end the replacement turn");
  // Stop during the same kind of tool, then send at once: Stop succeeds and the
  // message waits for Pi instead of queueing behind the stopped turn.
  await paseo.client.sendAgentMessage(agent.id, "run the slow tool");
  await until(async () => (await receipts()).filter(value => value.value === "started").length === 2, "the slow tool runs again");
  // Paseo's client throws when Stop is refused.
  await paseo.client.cancelAgent(agent.id);
  await paseo.client.sendAgentMessage(agent.id, "next question");
  await until(async () => (await modelInputs()).some(input => input.includes("next question")), "a message after Stop reaches the model");
  const after = (await receipts()).map(value => value.value);
  assert.ok(after.lastIndexOf("finished") < after.findIndex(value => String(value).includes("next question")),
    "the message after Stop starts once Pi has stopped");
});

// A chat started in Paseo runs Pi in the background. Resuming its session in a
// terminal moves it there without closing the chat; closing the terminal moves
// it back, so either side can continue the same session.
test("a chat started in Paseo moves to a terminal Pi and back", { skip, timeout: 120_000 }, async t => {
  const paseo = await stockPaseo(t);
  // The background Pi loads the bridge and an offline model from Pi's settings.
  await writeFile(path.join(paseo.agentDir, "settings.json"), JSON.stringify({
    extensions: [path.join(root, "extension/index.ts"), path.join(root, "test/fixtures/offline-provider.ts")],
  }));
  const agent = await paseo.client.createAgent({ provider: "pi", cwd: paseo.cwd, model: "bridge-offline/fixture", title: "From Paseo" });
  const items = async () => {
    const timeline = await paseo.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 200 });
    return (timeline.entries ?? []).map((entry: any) => entry.item ?? entry);
  };
  const waitForItem = async (predicate: (item: any) => boolean, label: string) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const found = (await items()).find(predicate);
      if (found) return found;
      await delay(250);
    }
    assert.fail(`${label}: ${JSON.stringify(await items()).slice(-3000)} ${paseo.stderr()}`);
  };
  const run = async (text: string) => {
    await paseo.client.sendAgentMessage(agent.id, text);
    const finished = await paseo.client.waitForFinish(agent.id, 30_000);
    assert.notEqual(finished.status, "error", `${text}: ${JSON.stringify(finished)}`);
    return finished;
  };
  const records = async () => {
    const directory = path.join(paseo.home, ".pi", "paseo-bridge", "runtimes");
    const files = await readdir(directory).catch(() => [] as string[]);
    return Promise.all(files.filter(file => file.endsWith(".json")).map(async file => JSON.parse(await readFile(path.join(directory, file), "utf8"))));
  };

  // Chat-only: the bridge's commands answer in the chat.
  await run("hello from the app");
  await run("/name Shared plan");
  await waitForItem(item => item.type === "assistant_message" && item.text === "Session name set: Shared plan", "/name in a Paseo chat");
  await run("/session");
  await waitForItem(item => item.type === "assistant_message" && /^Session info/.test(item.text), "/session in a Paseo chat");
  await run("/btw what next?");
  await waitForItem(item => item.type === "assistant_message" && item.text === "btw: what next?\n\nbackground side answer", "/btw in a Paseo chat");
  await paseo.client.sendAgentMessage(agent.id, "/new elsewhere");
  const refused = await paseo.client.waitForFinish(agent.id, 20_000);
  assert.equal(refused.status, "error");
  assert.match(JSON.stringify(refused) + JSON.stringify(await items()), /cannot follow/);
  const background = (await records()).find(record => record.kind === "headless");
  assert.ok(background, "the background Pi is published for a terminal takeover");
  assert.equal(background.agentId, agent.id);
  const sessionFile = background.sessionFile;
  assert.match(await readFile(sessionFile, "utf8"), /background answered[\s\S]*Shared plan/);

  // The terminal resumes the same session and takes it over.
  const notifyFile = path.join(paseo.home, "terminal-notify.jsonl");
  const terminal = paseo.startSession(sessionFile, { DIALOG_NOTIFY_FILE: notifyFile });
  const notices = async () => readFile(notifyFile, "utf8").catch(() => "");
  for (let attempt = 0; attempt < 120 && !/Took this session over from Paseo/.test(await notices()); attempt += 1) await delay(250);
  assert.match(await notices(), /Took this session over from Paseo/, paseo.stderr());
  for (let attempt = 0; attempt < 120 && !(await records()).some(record => record.kind === "terminal"); attempt += 1) await delay(250);
  assert.ok(!(await records()).some(record => record.kind === "headless"), "only the terminal writes the session now");
  // The same Paseo chat now reaches the terminal Pi.
  let reached = false;
  for (let attempt = 0; attempt < 40 && !reached; attempt += 1) {
    await paseo.client.sendAgentMessage(agent.id, `/stock-notify From the app ${attempt}`);
    await paseo.client.waitForFinish(agent.id, 10_000).catch(() => undefined);
    reached = /From the app/.test(await notices());
    if (!reached) await delay(250);
  }
  assert.ok(reached, `the chat reaches the terminal Pi: ${await notices()} ${paseo.stderr()}`);
  assert.equal((await paseo.piAgents()).length, 1, "Paseo keeps one chat for the session");

  // Closing the terminal hands the session back to a background Pi.
  terminal.stdin!.end();
  await once(terminal, "exit");
  let back = false;
  for (let attempt = 0; attempt < 80 && !back; attempt += 1) {
    back = (await records()).some(record => record.kind === "headless" && record.sessionFile === sessionFile);
    if (!back) await delay(250);
  }
  assert.ok(back, `a background Pi resumes the session: ${paseo.stderr()}`);
  await run("/name Back in Paseo");
  await waitForItem(item => item.type === "assistant_message" && item.text === "Session name set: Back in Paseo", "the chat continues in Paseo");
  assert.match(await readFile(sessionFile, "utf8"), /Back in Paseo/);
});
