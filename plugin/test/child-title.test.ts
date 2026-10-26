import test from "node:test";
import assert from "node:assert/strict";
import { correlateChildRoutes, nativeChildTitle } from "../shared/existing-child-identity.ts";

const identity = { taskId: `subagent-task-${"1".repeat(24)}`, childId: `subagent-child-${"2".repeat(24)}`, groupId: `subagent-job-${"3".repeat(24)}`, runtimeId: "runtime-1", attempt: 2 };
const row = { ...identity, title: "URGENT full task instruction prefix", paseoAgentId: "forged", paseoWorkspaceId: "unrelated" };
const record = { ...identity, parentSessionId: "owner", lifecycle: "active", managed: true, pid: 123, processStartToken: "boot:456", agentId: "native-child", workspaceId: "native-workspace" };
const token = (pid: number) => pid === 123 ? "boot:456" : null;

test("Work native title is correlated to exact child, not another parallel group member or prompt", () => {
  const other = { ...record, childId: `subagent-child-${"4".repeat(24)}`, taskId: `subagent-task-${"5".repeat(24)}`, agentId: "parallel-child" };
  const page = correlateChildRoutes({ items: [row] }, "owner", [other, record], token);
  assert.equal(page.items[0].paseoAgentId, "native-child");
  const catalog = new Map([
    ["native-child", { workspaceId: "native-workspace", title: "Urgent" }],
    ["parallel-child", { workspaceId: "native-workspace", title: "Unrelated private title" }],
  ]);
  assert.equal(nativeChildTitle(page.items[0], id => catalog.get(id)), "Urgent");
  assert.equal(row.title, "URGENT full task instruction prefix", "original task metadata retained separately");
  catalog.set("native-child", { workspaceId: "native-workspace", title: "Renamed native child" });
  assert.equal(nativeChildTitle(page.items[0], id => catalog.get(id)), "Renamed native child", "native rename is authoritative, not cached task text");
  catalog.set("native-child", { workspaceId: "different-workspace", title: "Wrong workspace private title" });
  assert.equal(nativeChildTitle(page.items[0], id => catalog.get(id)), row.title);
});

test("changed owner/attempt/runtime/group/child/process never emits stale route/title hints", () => {
  for (const change of [{ parentSessionId: "other-owner" }, { attempt: 3 }, { runtimeId: "other-runtime" }, { groupId: "other-group" }, { childId: "other-child" }, { processStartToken: "reused-pid" }, { lifecycle: "reaped" }]) {
    const result = correlateChildRoutes({ items: [row] }, "owner", [{ ...record, ...change }], token);
    assert.equal(result.items[0].paseoAgentId, undefined);
    assert.equal(result.items[0].paseoWorkspaceId, undefined);
    assert.equal(nativeChildTitle(result.items[0], () => ({ workspaceId: "unrelated", title: "Unrelated private title" })), row.title);
  }
});

test("title fallback stays bounded/name-first and registry batch caches process probes", () => {
  assert.equal(nativeChildTitle({ title: "reviewer" }, () => undefined), "reviewer");
  assert.equal(nativeChildTitle({ title: "x".repeat(1000) }, () => undefined).length, 140);
  assert.equal(nativeChildTitle({ title: "" }, () => undefined), "Worker");
  let probes = 0;
  correlateChildRoutes({ items: [row, row] }, "owner", [record], pid => { probes++; return token(pid); });
  assert.equal(probes, 1, "one process identity probe per batch, no per-row RPC/catalog scan");
  assert.throws(() => correlateChildRoutes({ items: Array(51).fill(row) }, "owner", [record], token), /page size/);
});
