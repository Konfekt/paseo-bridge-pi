import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeConversationStale } from "../shared/conversation-compat.ts";

test("old conversation DTO missing item.stale is accepted conservatively as retained", () => {
  assert.deepEqual(normalizeConversationStale({ childId: "child" }), { childId: "child", stale: true });
  assert.equal(normalizeConversationStale({ stale: false }).stale, false);
  assert.equal(normalizeConversationStale({ stale: true }).stale, true);
  assert.equal(normalizeConversationStale({ stale: "fresh" }).stale, true);
});
