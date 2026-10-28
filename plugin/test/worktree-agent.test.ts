import assert from "node:assert/strict";
import test from "node:test";
import { recordedAgentDisplayName, recordedAgentName, recordedAgentRoute } from "../shared/worktree-agent.ts";
import { worktreeLinkKeyboardProps } from "../shared/worktree-link.ts";
const taskId = `subagent-task-${"a".repeat(24)}`, childId = `subagent-child-${"b".repeat(24)}`;
const owner = { ownerSessionId: "owner-session", taskId, childId, canonicalDisplayName: "Stock Pi Bridge" };
const root = { agentId: "parent-agent", workspaceId: "parent-workspace", sessionId: "owner-session", runtimeEpoch: "epoch" };
const item = { taskId, childId, groupId: `subagent-job-${"c".repeat(24)}`, runtimeId: "current-runtime", attempt: 2, stale: false, reaped: false, paseoAgentId: "verified-child-agent", paseoWorkspaceId: "verified-child-workspace" };
test("directory links activate once on web Enter, not repeat/Space/disabled/native events", () => {
  let opened = 0, prevented = 0, stopped = 0;
  const event = { key: "Enter", preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  const active = worktreeLinkKeyboardProps("web", false, () => opened++);
  active.onKeyDown?.(event);
  active.onKeyDown?.({ ...event, repeat: true });
  active.onKeyDown?.({ ...event, key: " " });
  worktreeLinkKeyboardProps("web", true, () => opened++).onKeyDown?.(event);
  assert.equal(opened, 1); assert.equal(prevented, 1); assert.equal(stopped, 1);
  assert.deepEqual(worktreeLinkKeyboardProps("ios", false, () => opened++), {});
  assert.deepEqual(worktreeLinkKeyboardProps("android", false, () => opened++), {});
});
test("worktree owner names use only explicitly canonical short display names", () => {
  assert.equal(recordedAgentName(owner), "Stock Pi Bridge");
  assert.equal(recordedAgentName({ ...owner, canonicalDisplayName: "Release   Review" }), "Release Review");
  for (const canonicalDisplayName of [undefined, "", " one ", "one two three four five", "raw\ntask prompt", "Zero\u200bWidth", "a".repeat(81)]) {
    assert.equal(recordedAgentName({ ...owner, canonicalDisplayName }), null);
  }
  assert.equal(recordedAgentName({ ...owner, canonicalDisplayName: undefined, ownerTitle: "RAW TASK INSTRUCTIONS" } as typeof owner), null);
});
test("legacy names fall back only to exact verified native agent/workspace title", () => {
  const legacy = { ...owner, canonicalDisplayName: undefined };
  const link = { agentId: "verified-child-agent", workspaceId: "verified-child-workspace" };
  const native = { id: link.agentId, workspaceId: link.workspaceId, title: "Native Child Name" };
  assert.equal(recordedAgentDisplayName(legacy, link, native), "Native Child Name");
  assert.equal(recordedAgentDisplayName(owner, link, native), "Stock Pi Bridge", "recorded canonical name takes precedence");
  assert.equal(recordedAgentDisplayName(legacy, null, native), null);
  assert.equal(recordedAgentDisplayName(legacy, link, { ...native, workspaceId: "unrelated" }), null);
  assert.equal(recordedAgentDisplayName(legacy, link, { ...native, id: "unrelated" }), null);
  assert.equal(recordedAgentDisplayName(legacy, link, { ...native, title: "Raw full task instructions do not display" }), null);
});
test("worktree route requests preserve exact current tuple and source; do not guess agent id", () => {
  assert.deepEqual(recordedAgentRoute(owner, root, [item], true), { ...root, taskId, childId, groupId: item.groupId, runtimeId: item.runtimeId, attempt: 2 });
  const source = { ...root, sessionId: "descendant-session", agentId: "verified-descendant", workspaceId: "descendant-workspace" };
  assert.deepEqual(recordedAgentRoute({ ...owner, ownerSessionId: source.sessionId }, root, [{ ...item, source }], true), { ...source, taskId, childId, groupId: item.groupId, runtimeId: item.runtimeId, attempt: 2 });
});
test("worktree route requests fail closed for incomplete, ambiguous, stale, reaped or unrelated evidence", () => {
  for (const items of [[], [item, item], [{ ...item, stale: true }], [{ ...item, reaped: true }], [{ ...item, runtimeId: null }], [{ ...item, paseoAgentId: undefined }], [{ ...item, paseoWorkspaceId: undefined }], [{ ...item, childId: `subagent-child-${"d".repeat(24)}` }], [{ ...item, source: { ...root, sessionId: "unrelated-session" } }], [{ ...item, attempt: 0 }], [{ ...item, groupId: "guessed-group" }]]) {
    assert.equal(recordedAgentRoute(owner, root, items, true), null);
  }
  assert.equal(recordedAgentRoute(owner, root, [item], false), null);
  assert.equal(recordedAgentRoute({ ...owner, childId: "" }, root, [item], true), null);
  assert.equal(recordedAgentRoute({ ...owner, ownerSessionId: "unrelated-session" }, root, [item], true), null);
});
