import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The pinned development Pi, run by the shim as Paseo runs it for a chat
// started in the app: no terminal, RPC mode, the bridge loaded as an extension.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const piCli = path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");

test("Pi's built-ins answer in a Paseo chat that Pi runs in the background", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-headless-"));
  const child = spawn(process.execPath, [path.join(root, "shim/pi-paseo-shim.js"), "--mode", "rpc", "-e", path.join(root, "extension/index.ts")], {
    cwd: home,
    env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home, PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"), PI_REAL_BIN: piCli,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const frames = () => output.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const waitFor = async (predicate: (frame: any) => boolean, label: string) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const found = frames().find(predicate);
      if (found) return found;
      assert(Date.now() < deadline, `${label}: ${output.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  try {
    send({ id: "c", type: "get_commands" });
    const names = (await waitFor(frame => frame.id === "c", "commands")).data.commands.map((command: any) => command.name);
    for (const name of ["name", "model", "thinking", "session", "export", "btw"]) assert(names.includes(name), `lists /${name}: ${names}`);
    for (const name of ["new", "resume", "clone"]) assert(!names.includes(name), `does not list /${name}`);
    send({ id: "n", type: "prompt", message: "/name Field notes" });
    await waitFor(frame => frame.type === "command_output" && frame.text === "Session name set: Field notes", "/name output");
    assert.equal((await waitFor(frame => frame.id === "n", "/name response")).success, true);
    send({ id: "s", type: "prompt", message: "/session" });
    await waitFor(frame => frame.type === "command_output" && /^Session info[\s\S]*Name: Field notes/.test(frame.text), "/session output");
    send({ id: "t", type: "prompt", message: "/thinking banana" });
    assert.match((await waitFor(frame => frame.id === "t", "/thinking failure")).error, /Unknown thinking level/);
    send({ id: "r", type: "prompt", message: "/resume" });
    assert.match((await waitFor(frame => frame.id === "r", "/resume refusal")).error, /cannot follow/);
    send({ id: "x", type: "prompt", message: "/tree" });
    assert.match((await waitFor(frame => frame.id === "x", "/tree refusal")).error, /not available from Paseo/);
    send({ id: "a", type: "set_auto_compaction", enabled: false });
    assert.equal((await waitFor(frame => frame.id === "a", "autocompact")).success, true);
    send({ id: "g", type: "get_state" });
    assert.equal((await waitFor(frame => frame.id === "g", "state")).data.autoCompactionEnabled, false);
    const settings = await readFile(path.join(home, ".pi", "agent", "settings.json"), "utf8").catch(() => "{}");
    assert.equal(JSON.parse(settings).compaction?.enabled, undefined, "Pi's global setting stays unchanged");
    assert(!output.includes("PI_PASEO_BRIDGE_FRAME"), "bridge frames never reach Paseo");
  } finally {
    child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});
