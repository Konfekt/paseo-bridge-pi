import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  bridgeCommandEntries, BRIDGE_HANDLED_COMMANDS, KNOWN_PI_BUILTINS, loadPiBuiltinNames, parseSlashInvocation, routePaseoCommand,
} from "../extension/builtin-commands.ts";

const builtins = new Set<string>(KNOWN_PI_BUILTINS);
// The package exports only its entry point, dist/index.js.
const piPackage = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));

test("the maintained built-in list covers the pinned Pi's registry", async () => {
  const { BUILTIN_SLASH_COMMANDS } = await import(pathToFileURL(path.join(piPackage, "dist/core/slash-commands.js")).href);
  const missing = BUILTIN_SLASH_COMMANDS.map((command: { name: string }) => command.name).filter((name: string) => !builtins.has(name));
  assert.deepEqual(missing, [], "add new Pi built-ins to KNOWN_PI_BUILTINS and decide whether the bridge runs them");
});

test("the running Pi's registry extends the maintained list", async () => {
  const names = await loadPiBuiltinNames(path.join(piPackage, "dist/cli.js"));
  for (const name of KNOWN_PI_BUILTINS) assert.ok(names.has(name));
  assert.ok(names.has("settings"));
  // A compiled Pi or an unknown entry keeps the maintained list.
  assert.deepEqual([...await loadPiBuiltinNames("/nonexistent/pi")].sort(), [...builtins].sort());
  assert.deepEqual([...await loadPiBuiltinNames(undefined)].length >= builtins.size, true);
});

test("slash parsing matches Paseo: a name with a slash is a path", () => {
  assert.deepEqual(parseSlashInvocation("  /name  Release plan "), { name: "name", args: "Release plan" });
  assert.deepEqual(parseSlashInvocation("/session"), { name: "session", args: "" });
  assert.equal(parseSlashInvocation("/usr/bin/env is missing"), null);
  assert.equal(parseSlashInvocation("plain text"), null);
  assert.equal(parseSlashInvocation("/"), null);
});

test("Pi built-ins run in the bridge, are refused, or pass to Pi", () => {
  const none: Array<{ name: string; source: string }> = [];
  for (const { name } of BRIDGE_HANDLED_COMMANDS) {
    assert.deepEqual(routePaseoCommand(`/${name} x y`, none, builtins), { kind: "bridge", name, args: "x y" });
  }
  for (const name of ["settings", "hotkeys", "quit", "login", "copy", "tree", "fork", "dementedelves"]) {
    const route = routePaseoCommand(`/${name}`, none, builtins);
    assert.equal(route.kind, "reject", name);
    assert.match((route as any).message, new RegExp(`^/${name} is a Pi terminal command and is not available from Paseo\\. `));
  }
  // Paseo runs /compact and /autocompact itself; unknown names and text reach Pi.
  for (const message of ["/compact", "/autocompact off", "/my-template arg", "hello", "/tmp/file.txt is big"]) {
    assert.deepEqual(routePaseoCommand(message, none, builtins), { kind: "pass" }, message);
  }
  // A future built-in learnt from Pi's registry is refused too.
  assert.equal(routePaseoCommand("/brand-new", none, new Set([...builtins, "brand-new"])).kind, "reject");
});

test("extension, prompt and skill commands keep their names, except Paseo's /btw", () => {
  const commands = [
    { name: "session", source: "extension" }, { name: "new", source: "prompt" }, { name: "btw", source: "extension" },
  ];
  assert.deepEqual(routePaseoCommand("/session", commands, builtins), { kind: "pass" });
  assert.deepEqual(routePaseoCommand("/new idea", commands, builtins), { kind: "pass" });
  assert.deepEqual(routePaseoCommand("/skill:review now", commands, builtins), { kind: "pass" });
  // pi-btw's /btw opens a terminal overlay Paseo cannot show.
  assert.deepEqual(routePaseoCommand("/btw why?", commands, builtins), { kind: "bridge", name: "btw", args: "why?" });
  assert.deepEqual(routePaseoCommand("/btw why?", commands, builtins, { nativeBtw: false }), { kind: "pass" });
  const listed = bridgeCommandEntries(commands).map(command => command.name);
  assert.ok(!listed.includes("session") && !listed.includes("new"), "Pi's own commands are not shadowed");
  assert.ok(listed.includes("btw") && listed.includes("model"));
  assert.ok(bridgeCommandEntries([]).every(command => command.source === "extension" && command.description.length > 0));
});
