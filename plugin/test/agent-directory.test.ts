import assert from "node:assert/strict";
import test from "node:test";
import { observeAgentDirectory, retainContribution } from "../client/agent-directory.ts";

const flush = () => new Promise(resolve => setImmediate(resolve));
const agent = (id: string) => ({ id, provider: "pi", workspaceId: "workspace" });
const snapshot = (ids: string[], nextCursor: string | null = null) => ({
  entries: ids.map(id => ({ agent: agent(id) })), pageInfo: { hasMore: !!nextCursor, nextCursor },
});
function fixture() {
  const requests: any[] = [], observers: any[] = [], disposed: number[] = [];
  let list = async (_options: any): Promise<any> => snapshot([]);
  const client: any = { paseo: { agents: { list: async (options: any) => {
    requests.push(options);
    if (!options.subscribe) return list(options);
    return { subscription: { subscribe(observer: any) {
      const index = observers.push(observer) - 1;
      return () => { disposed.push(index); };
    } } };
  } } } };
  const values = new Map<string, any>();
  const observer = { snapshot(agents: any[]) { values.clear(); for (const a of agents) values.set(a.id, a); },
    upsert(a: any) { values.set(a.id, a); }, remove(id: string) { values.delete(id); } };
  return { client, requests, observers, disposed, values, observer, pages(fn: typeof list) { list = fn; } };
}

test("one background catalogue, replay to later consumers, balanced idempotent leases and remount", async () => {
  const f = fixture();
  const stop1 = observeAgentDirectory(f.client, f.observer);
  const other = new Map();
  const stop2 = observeAgentDirectory(f.client, { ...f.observer, snapshot: agents => agents.forEach(a => other.set(a.id, a)) });
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].includeBackground, true);
  f.observers[0].snapshot(snapshot(["main", "background-child"]));
  assert.equal(other.size, 2);
  stop1(); stop1();
  assert.equal(f.requests[0].signal.aborted, false);
  let replay: any[] = [];
  const stop3 = observeAgentDirectory(f.client, { ...f.observer, snapshot: agents => { replay = agents; } });
  assert.equal(replay.length, 2);
  stop2(); stop3();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.deepEqual(f.disposed, [0]);
  const again = observeAgentDirectory(f.client, f.observer);
  await flush();
  assert.equal(f.requests.length, 2);
  f.observers[0].snapshot(snapshot(["stale"]));
  assert.equal(f.values.has("stale"), false);
  again();
});

test("pagination retains older agents; racing rename/removal/new child wins over stale pages", async () => {
  const f = fixture();
  let resolvePage: (value: any) => void = () => {};
  f.pages(() => new Promise(resolve => { resolvePage = resolve; }));
  const stop = observeAgentDirectory(f.client, f.observer);
  try {
    await flush();
    const source = f.observers[0];
    source.snapshot(snapshot(["main", "old"]));
    source.snapshot(snapshot(["main"], "older"));
    assert.equal(f.values.has("old"), true, "partial reconnect page is not a removal");
    source.update({ type: "agent_update", payload: { kind: "upsert", agent: { ...agent("old"), title: "renamed" } } });
    source.update({ type: "agent_update", payload: { kind: "remove", agentId: "removed" } });
    source.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("new-child") } });
    resolvePage(snapshot(["old", "removed", "background-child"]));
    await flush();
    assert.deepEqual([...f.values.keys()].sort(), ["background-child", "main", "new-child", "old"]);
    assert.equal(f.values.get("old").title, "renamed");
    assert.equal(f.requests[1].includeBackground, true);
  } finally { stop(); }
});

test("new reconnect snapshot and disposal invalidate pending pages", async () => {
  const f = fixture();
  const pending: ((value: any) => void)[] = [];
  f.pages(() => new Promise(resolve => pending.push(resolve)));
  const stop = observeAgentDirectory(f.client, f.observer);
  await flush();
  f.observers[0].snapshot(snapshot(["old"], "cursor"));
  f.observers[0].snapshot(snapshot(["new"]));
  pending[0](snapshot(["stale"])); await flush();
  assert.deepEqual([...f.values.keys()], ["new"]);
  f.observers[0].snapshot(snapshot(["new"], "cursor"));
  stop();
  pending[1](snapshot(["after-dispose"])); await flush();
  f.observers[0].update({ type: "agent_update", payload: { kind: "remove", agentId: "new" } });
  assert.deepEqual([...f.values.keys()], ["new"]);
});

test("failed bootstrap retries; disposal cancels the retry without removing other installations", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  let attempts = 0;
  const f = fixture(), initial = f.client.paseo.agents.list;
  f.client.paseo.agents.list = (options: any) => ++attempts === 1 ? Promise.reject(new Error("offline")) : initial(options);
  const stop = observeAgentDirectory(f.client, f.observer);
  await flush(); assert.equal(attempts, 1);
  t.mock.timers.tick(5000); await flush(); assert.equal(attempts, 2);
  f.observers[0].snapshot(snapshot(["reconnected"]));
  assert.equal(f.values.has("reconnected"), true);
  const other = fixture();
  const stopOther = observeAgentDirectory(other.client, other.observer);
  await flush();
  stop();
  assert.equal(other.requests[0].signal.aborted, false);
  stopOther();
  const blocked = fixture();
  blocked.client.paseo.agents.list = () => { attempts++; return Promise.reject(new Error("offline")); };
  const cancel = observeAgentDirectory(blocked.client, blocked.observer);
  await flush(); cancel(); const before = attempts;
  t.mock.timers.tick(10000); await flush(); assert.equal(attempts, before);
});

test("a failed older page preserves inventory and retries rather than publishing a partial removal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const f = fixture(); f.pages(async () => { throw new Error("page unavailable"); });
  const stop = observeAgentDirectory(f.client, f.observer);
  try {
    await flush();
    f.observers[0].snapshot(snapshot(["main", "older-child"]));
    f.observers[0].snapshot(snapshot(["main"], "older"));
    await flush();
    assert.equal(f.values.has("older-child"), true);
    assert.equal(f.requests[0].signal.aborted, true);
    t.mock.timers.tick(5000); await flush();
    f.observers[1].snapshot(snapshot(["main", "older-child"]));
    assert.equal(f.values.size, 2);
  } finally { stop(); }
});

test("contribution leases start once, tolerate arbitrary disposal order, and recreate after final release", () => {
  const client: any = {}, other: any = {};
  let starts = 0, stops = 0;
  const start = () => { starts++; return () => { stops++; }; };
  const a = retainContribution(client, "accounts", start), b = retainContribution(client, "accounts", start);
  const c = retainContribution(other, "accounts", start);
  assert.equal(starts, 2);
  b(); b(); assert.equal(stops, 0);
  a(); assert.equal(stops, 1);
  const d = retainContribution(client, "accounts", start);
  assert.equal(starts, 3);
  c(); d(); assert.equal(stops, 3);
  assert.throws(() => retainContribution(client, "accounts", () => { throw new Error("setup"); }));
  retainContribution(client, "accounts", start)();
  assert.equal(starts, 4); assert.equal(stops, 4);
});
