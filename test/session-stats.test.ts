import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildSessionStats } from "../extension/session-stats.ts";

const usage = {
  input: 10, output: 20, cacheRead: 30, cacheWrite: 40,
  reasoning: 7, cacheWrite1h: 9, totalTokens: 999,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};
function context(entries: any[] = [], contextUsage: any = undefined) {
  return {
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => "session-id",
      getSessionFile: () => "/session.jsonl",
      getBranch: () => { throw new Error("Accounting must not use the active branch"); },
      buildContextEntries: () => { throw new Error("Accounting must not use compacted context"); },
    },
    getContextUsage: () => contextUsage,
  } as Parameters<typeof buildSessionStats>[0];
}
const assistant = (id: string, parentId: string | null = null, stopReason = "stop") => ({
  type: "message", id, parentId,
  message: { role: "assistant", content: [{ type: "toolCall" }, { type: "text" }], usage, stopReason },
});

test("empty and not-yet-started sessions return zero totals", () => {
  for (const ctx of [null, context()]) {
    const stats = buildSessionStats(ctx);
    assert.deepEqual(stats.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    assert.equal(stats.cost, 0);
    assert.equal(stats.totalMessages, 0);
    assert.equal("contextUsage" in JSON.parse(JSON.stringify(stats)), false);
  }
});

test("matches full-session accounting across branches, compaction, edits and nested tools", () => {
  const entries = [
    { type: "message", id: "user", message: { role: "user" } },
    assistant("abandoned", "user"),
    assistant("active", "user", "aborted"),
    assistant("failed", "active", "error"),
    { type: "message", message: { role: "toolResult", usage, details: { usage } } },
    { type: "message", message: { role: "toolResult" } },
    { type: "message", message: { role: "system" } },
    { type: "message", message: { role: "bashExecution" } },
    { type: "compaction", usage, tokensBefore: 100000, details: { usage } },
    { type: "branch_summary", usage, fromId: "abandoned" },
    { type: "usage", kind: "cache_warm", usage },
    { type: "usage", kind: "future-kind", usage },
    { type: "compaction" },
    { type: "branch_summary" },
    { type: "context_edit", targetId: "active", replacement: null },
    { type: "custom", data: { usage } },
    { type: "custom_message", details: { usage } },
  ];
  const contextUsage = { tokens: null, percent: null, contextWindow: 200000 };
  const ctx = context(entries, contextUsage);
  const stats = buildSessionStats(ctx);
  assert.deepEqual(stats, {
    sessionFile: "/session.jsonl", sessionId: "session-id",
    userMessages: 1, assistantMessages: 3, toolCalls: 3, toolResults: 2, totalMessages: 8,
    tokens: { input: 80, output: 160, cacheRead: 240, cacheWrite: 320, total: 800 },
    cost: 8, contextUsage,
  });
  assert.equal(stats.contextUsage, contextUsage);
  const nativeStats = AgentSession.prototype.getSessionStats.call({
    sessionManager: ctx!.sessionManager,
    sessionFile: "/session.jsonl", sessionId: "session-id",
    getContextUsage: () => contextUsage,
  } as unknown as AgentSession);
  assert.deepEqual(stats, nativeStats, "must match the pinned Pi RPC implementation");
  assert.deepEqual(buildSessionStats(ctx), stats, "polling must not accumulate totals twice");
  entries.push(assistant("next"));
  assert.equal(buildSessionStats(ctx).tokens.total, 900);
  assert.equal(buildSessionStats(context()).cost, 0, "session switches must not retain prior totals");
});

test("context usage is passed through independently of cumulative usage", () => {
  const contextUsage = { tokens: 1234, percent: 0.617, contextWindow: 200000 };
  const stats = buildSessionStats(context([assistant("one")], contextUsage));
  assert.equal(stats.contextUsage, contextUsage);
  assert.equal(stats.tokens.total, 100);
});
