import assert from "node:assert/strict";
import { test } from "node:test";
import { CanonicalNameSync } from "../extension/canonical-name-sync.ts";

function fixture(deferred = false) {
  let record = { displayName: "Parser Review", revision: 1 };
  let current = true;
  const writes: { name: string; updateAgent: boolean }[] = [];
  const warnings: string[] = [];
  const releases: (() => void)[] = [];
  const sync = new CanonicalNameSync({
    authority: { get: () => record, rename: (name, revision) => {
      assert.equal(revision, record.revision);
      record = { displayName: name.replace(/\s+/gu, " "), revision: revision + 1 };
      return record;
    } },
    isCurrent: () => current,
    write: async (name, updateAgent) => { writes.push({ name, updateAgent }); if (deferred) await new Promise<void>(resolve => releases.push(resolve)); },
    warn: message => warnings.push(message),
  });
  return { sync, writes, warnings, releases, get: () => record,
    local(name: string) { record = { displayName: name, revision: record.revision + 1 }; sync.changed(); },
    stale() { current = false; },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("existing native user rename wins initial observation and echoes do not create another revision", async () => {
  const f = fixture();
  f.sync.observe("User Parser Name");
  await f.sync.settled();
  assert.deepEqual(f.get(), { displayName: "User Parser Name", revision: 2 });
  assert.deepEqual(f.writes, [{ name: "User Parser Name", updateAgent: false }]);
  f.local("Pi Parser Name");
  await f.sync.settled();
  assert.equal(f.writes.at(-1)?.name, "Pi Parser Name");
  const revision = f.get().revision;
  f.sync.observe("Pi Parser Name");
  await f.sync.settled();
  assert.equal(f.get().revision, revision);
  assert.equal(f.writes.length, 2);
});

test("a delayed reconnect baseline never overwrites a newer local rename made during admission", async () => {
  const f = fixture();
  f.local("New Local Name");
  f.sync.observe("Parser Review");
  await f.sync.settled();
  assert.deepEqual(f.get(), { displayName: "New Local Name", revision: 2 });
  assert.deepEqual(f.writes, [{ name: "New Local Name", updateAgent: true }]);
  f.sync.observe("New Local Name"); await f.sync.settled();
  assert.equal(f.get().revision, 2);
});

test("status-only native snapshots are not new renames while a Pi title write is pending", async () => {
  const f = fixture(true);
  f.sync.observe("Parser Review"); f.releases.shift()!(); await f.sync.settled();
  f.local("New Pi Name");
  const revision = f.get().revision;
  f.sync.observe("Parser Review"); // Same title, merely another status snapshot.
  assert.equal(f.get().displayName, "New Pi Name");
  assert.equal(f.get().revision, revision);
  f.sync.observe("New Pi Name");
  f.releases.shift()!(); await f.sync.settled();
  assert.equal(f.get().displayName, "New Pi Name");
  assert.equal(f.get().revision, revision);
});

test("serialized stale asynchronous writes converge to latest observed external rename, not their acknowledgments", async () => {
  const f = fixture(true);
  f.sync.observe("Parser Review");
  f.releases.shift()!(); await f.sync.settled();
  f.local("First Pi Name");
  f.local("Second Pi Name");
  f.sync.observe("Human Latest Name");
  assert.equal(f.get().displayName, "Human Latest Name");
  f.sync.observe("First Pi Name"); // Own delayed echo, not a human rename.
  assert.equal(f.get().displayName, "Human Latest Name");
  f.releases.shift()!(); await tick();
  assert.equal(f.writes.at(-1)?.name, "Human Latest Name");
  assert.equal(f.writes.some(write => write.name === "Second Pi Name"), false);
  f.sync.observe("Human Latest Name");
  f.releases.shift()!(); await f.sync.settled();
  assert.equal(f.get().displayName, "Human Latest Name");
  assert.equal(f.get().revision, 4);
});

test("invalid external names visibly restore one canonical name without a revision or feedback loop", async () => {
  const f = fixture();
  f.sync.observe("one two three four five"); await f.sync.settled();
  assert.equal(f.get().revision, 1);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.writes[0].name, "Parser Review");
  f.sync.observe("Parser Review"); await f.sync.settled();
  f.sync.observe("one two three four five"); await f.sync.settled();
  assert.equal(f.warnings.length, 1);
  assert.equal(f.get().displayName, "Parser Review");
  f.sync.observe("Parser Review"); await f.sync.settled();
  assert.equal(f.writes.length, 2);
});

test("late sequence/generation events and stale runtime callbacks cannot rename another session", async () => {
  const f = fixture();
  f.sync.observe("New Name", { generation: "a", seq: 3 }); await f.sync.settled();
  f.sync.observe("Older Name", { generation: "a", seq: 2 });
  assert.equal(f.get().displayName, "New Name");
  f.sync.observe("Reconnect Name", { generation: "b", seq: 1 }); await f.sync.settled();
  f.sync.observe("Old Generation", { generation: "a", seq: 4 });
  assert.equal(f.get().displayName, "Reconnect Name");
  f.stale(); f.sync.observe("Wrong Runtime"); f.local("Local Only");
  await f.sync.settled();
  assert.equal(f.writes.at(-1)?.name, "Reconnect Name");
});

test("unavailable native writes retry without an acknowledgement rename or warning flood", async () => {
  let attempts = 0, warnings = 0;
  const record = { displayName: "Canonical Name", revision: 1 };
  const sync = new CanonicalNameSync({ authority: { get: () => record, rename: () => { throw new Error("No external rename expected"); } },
    isCurrent: () => true, write: async () => { if (++attempts < 3) throw new Error("workspace unavailable"); }, warn: () => warnings++ });
  sync.observe(null); await sync.settled();
  sync.changed(); await sync.settled();
  assert.equal(warnings, 1);
  sync.changed(); await sync.settled();
  assert.equal(attempts, 3);
  assert.equal(record.revision, 1);
  sync.close();
});

test("reconnect snapshots adopt latest observed native name without duplicate chat creation", async () => {
  const first = fixture();
  first.sync.observe("Parser Review"); await first.sync.settled();
  first.sync.close();
  first.sync.observe("Stale Closed Name");
  assert.equal(first.get().displayName, "Parser Review");
  const next = fixture();
  next.sync.observe("Offline User Rename"); await next.sync.settled();
  assert.equal(next.get().displayName, "Offline User Rename");
  assert.deepEqual(next.writes, [{ name: "Offline User Rename", updateAgent: false }]);
});
