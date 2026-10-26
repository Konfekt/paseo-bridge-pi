import test from "node:test";
import assert from "node:assert/strict";
import { sameReadOnlySession, assertReadOnlyConversationResponse, MAX_READ_ONLY_CONVERSATION_BYTES } from "../extension/read-only-session.ts";

const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id } });

test("500-message retained pages fit their512KiB producer budget plus bounded live metadata", () => {
  const result = { sessionId: "owner", item: { messages: Array.from({ length: 500 }, (_, id) => ({ id: String(id), role: "assistant", text: "x".repeat(900) })), liveText: "x".repeat(16 * 1024) } };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 48 * 1024, "regresses the actual old48KiB bridge rejection");
  assert.doesNotThrow(() => assertReadOnlyConversationResponse(result, "owner"));
  assert.throws(() => assertReadOnlyConversationResponse(result, "other-owner"), /owner session mismatch/);
  assert.throws(() => assertReadOnlyConversationResponse({ sessionId: "owner", item: { messages: [{ text: "x".repeat(MAX_READ_ONLY_CONVERSATION_BYTES) }] } }, "owner"), /read budget/);
  assert.ok(MAX_READ_ONLY_CONVERSATION_BYTES + 4096 < 768 * 1024, "bounded response envelope fits socket transport");
});

test("in-flight read survives ordinary Pi event context refresh for the same lifecycle/session", async () => {
  const lifecycle = {};
  let latest = ctx("owner");
  const original = latest;
  const pending = Promise.resolve().then(() => { latest = ctx("owner"); });
  await pending;
  assert.notEqual(latest, original);
  assert.equal(sameReadOnlySession(lifecycle, lifecycle, "owner", latest), true);
});

test("in-flight read rejects shutdown, changed session, and same-ID replacement lifecycle", () => {
  const captured = {};
  assert.equal(sameReadOnlySession(captured, captured, "owner", null), false);
  assert.equal(sameReadOnlySession(captured, captured, "owner", ctx("other")), false);
  assert.equal(sameReadOnlySession(captured, {}, "owner", ctx("owner")), false);
});

test("away-and-back lifecycle cannot release old results into the same public session ID", async () => {
  let lifecycle = {};
  const captured = lifecycle;
  let latest = ctx("owner");
  await Promise.resolve().then(() => {
    lifecycle = {}; latest = ctx("other");
    lifecycle = {}; latest = ctx("owner");
  });
  assert.equal(sameReadOnlySession(captured, lifecycle, "owner", latest), false);
});
