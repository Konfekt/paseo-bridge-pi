import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectedHistory, projectedUserCaptures } from "../extension/session-projection.ts";

test("projection keeps visible custom notices, current edited user text, and omits deleted context", () => {
  const entries = [
    { sourceEntry: { id: "u1", parentId: null, type: "message", message: { role: "user" } }, messages: [{ role: "user", content: "edited text" }] },
    { sourceEntry: { id: "notice", parentId: "u1", type: "custom_message", display: true }, messages: [{ role: "user", content: "notice" }] },
    { sourceEntry: { id: "deleted", parentId: "notice", type: "message", message: { role: "user" } }, messages: [] },
  ];
  const expectedMessages = [entries[0].messages[0], entries[1].messages[0]];
  const result = buildProjectedHistory([], "leaf", {
    buildSessionProjection: () => ({ entries, messages: expectedMessages }),
    buildSessionContext: () => ({ messages: [] }),
  });
  assert.deepEqual(result.messages, expectedMessages);
  assert.deepEqual(projectedUserCaptures(result.projectedEntries), [
    { id: "u1", parentId: null, text: "edited text" },
  ]);
});

test("empty canonical projections remain authoritative instead of restoring raw omitted messages", () => {
  const result = buildProjectedHistory([{ type: "message", message: { role: "user", content: "omitted" } }], "leaf", {
    buildSessionProjection: () => ({ entries: [], messages: [] }),
    buildSessionContext: () => { throw new Error("must not fall back from an empty projection"); },
  });
  assert.equal(result.hasProjection, true);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(projectedUserCaptures(result.projectedEntries), []);
});

test("older Pi fallback uses only canonical context messages", () => {
  const messages = [{ role: "user", content: "current context" }];
  assert.deepEqual(buildProjectedHistory([], null, {
    buildSessionContext: () => ({ messages }),
  }), { messages, projectedEntries: [], hasProjection: false });
});
