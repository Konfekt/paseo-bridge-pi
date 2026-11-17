import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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

// Paseo's sidebar lists workspaces; sessions sharing a folder workspace look like one session.
test("stock Paseo shows each pi session of one folder as its own workspace", {
  skip: !executable || !providerEntry || !paseoCli,
  timeout: 90_000,
}, async t => {
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
    PASEO_CLI: paseoCli!, PASEO_HOME: paseoHome,
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
  const daemon = await createPaseoDaemon({
    listen: "127.0.0.1:0", paseoHome, daemonVersion: hostPackage.version, corsAllowedOrigins: [], hostnames: true,
    mcpEnabled: false, browserToolsEnabled: false, staticDir: cwd, mcpDebug: false,
    agentClients: { pi: new PiRpcAgentClient({ logger, runtime: runtimeClient }) },
    agentStoragePath: path.join(paseoHome, "agents"), relayEnabled: false, pluginsEnabled: false,
  }, logger);
  const children: ReturnType<typeof spawn>[] = [];
  let client: any;
  t.after(async () => {
    for (const child of children) child.kill();
    await client?.close().catch(() => {});
    await daemon.stop?.();
    process.env.PATH = originalPath;
    await rm(temporary, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.getListenTarget();
  env.PASEO_HOST = `127.0.0.1:${address.port}`;
  client = createHostClient(env.PASEO_HOST, { clientId: "pi-workspaces", clientType: "cli", reconnect: { enabled: false } });
  await client.connect();
  // A workspace another agent already opened in the same folder.
  const folderWorkspace = (await client.createWorkspace({ source: { kind: "directory", path: cwd }, title: "Folder" })).workspace?.id;
  assert.ok(folderWorkspace);
  // Pi's own layout: per-cwd directory, timestamped files named by session UUID.
  const sessions = path.join(agentDir, "sessions", "--project--");
  await mkdir(sessions, { recursive: true });
  const sessionFiles = [
    "2026-01-01T00-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl",
    "2026-01-01T00-01-00-000Z_22222222-2222-4222-8222-222222222222.jsonl",
  ].map(name => path.join(sessions, name));
  const stderr: string[] = [];
  for (const [index, sessionFile] of sessionFiles.entries()) {
    const child = spawn(process.execPath, ["--experimental-strip-types", path.join(root, "test/fixtures/stock-dialog-session.mjs")], {
      cwd, env: { ...env, DIALOG_SESSION_FILE: sessionFile, DIALOG_READY_FILE: path.join(temporary, `ready-${index}`) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr!.on("data", chunk => stderr.push(String(chunk)));
    children.push(child);
  }
  let agents: any[] = [];
  for (let attempt = 0; attempt < 120 && agents.length < 2; attempt += 1) {
    await delay(250);
    agents = (await client.fetchAgents()).entries.map((entry: any) => entry.agent).filter((agent: any) => agent.provider === "pi");
  }
  assert.equal(agents.length, 2, `both sessions import; stderr: ${stderr.join("").slice(-2000)}`);
  const workspaceIds = agents.map(agent => agent.workspaceId);
  assert.equal(new Set([folderWorkspace, ...workspaceIds]).size, 3, `distinct workspaces: ${JSON.stringify(workspaceIds)}`);
  const workspaces = (await client.fetchWorkspaces()).entries;
  const realCwd = await realpath(cwd);
  for (const workspaceId of workspaceIds) {
    const workspace = workspaces.find((entry: any) => entry.id === workspaceId);
    assert.ok(workspace, `workspace ${workspaceId} is listed`);
    assert.equal(await realpath(workspace.workspaceDirectory ?? workspace.cwd ?? realCwd), realCwd);
  }
});
