import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveHeadlessOwner, sessionChangedOnDisk } from "../extension/session-takeover.ts";
import { routePaseoCommand } from "../extension/builtin-commands.ts";

test("a session file with entries this Pi has not loaded counts as changed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-takeover-"));
  try {
    const file = path.join(directory, "s.jsonl");
    const lines = (...ids: string[]) => fs.writeFileSync(file, [JSON.stringify({ type: "session", id: "h" }), ...ids.map(id => JSON.stringify({ id }))].join("\n") + "\n");
    lines("a", "b");
    assert.equal(sessionChangedOnDisk(file, [{ id: "a" }, { id: "b" }]), false);
    lines("a", "b", "c");
    assert.equal(sessionChangedOnDisk(file, [{ id: "a" }, { id: "b" }]), true);
    lines("a", "x");
    assert.equal(sessionChangedOnDisk(file, [{ id: "a" }, { id: "b" }]), true);
    assert.equal(sessionChangedOnDisk(path.join(directory, "missing.jsonl"), []), false);
    assert.equal(sessionChangedOnDisk(undefined, []), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("only a live background owner of another process is taken over", () => {
  const headless = { kind: "headless", pid: 42, bridgeSocket: "/h.sock", sessionFile: "/p/s.jsonl" };
  const terminal = { kind: "terminal", pid: 43, bridgeSocket: "/t.sock", sessionFile: "/p/s.jsonl" };
  assert.equal(liveHeadlessOwner("/p/s.jsonl", { records: [terminal, headless], mayBeAlive: () => true }), headless);
  assert.equal(liveHeadlessOwner("/p/s.jsonl", { records: [headless], mayBeAlive: () => false }), undefined);
  assert.equal(liveHeadlessOwner("/p/s.jsonl", { records: [headless], ownPid: 42, mayBeAlive: () => true }), undefined);
  assert.equal(liveHeadlessOwner("/p/other.jsonl", { records: [headless], mayBeAlive: () => true }), undefined);
});

test("a Paseo chat Pi runs in the background refuses session switches and points to a terminal", () => {
  const builtins = new Set(["new", "resume", "clone", "settings", "model"]);
  for (const name of ["new", "resume", "clone"]) {
    const route = routePaseoCommand(`/${name} x`, [], builtins, { headless: true });
    assert.equal(route.kind, "reject");
    assert.match((route as any).message, /cannot follow/);
    assert.equal(routePaseoCommand(`/${name} x`, [], builtins).kind, "bridge");
  }
  assert.match((routePaseoCommand("/settings", [], builtins, { headless: true }) as any).message, /not available from Paseo/);
  assert.deepEqual(routePaseoCommand("/model a/b", [], builtins, { headless: true }), { kind: "bridge", name: "model", args: "a/b" });
});
