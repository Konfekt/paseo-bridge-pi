import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { projectedUserCaptures } from "../extension/session-projection.ts";

test("history captures retain edited user identity without restoring omitted context or treating notices as user entries", () => {
  const timestamp = "2026-10-30T00:00:00.000Z";
  const entries: SessionEntry[] = [
    { id: "user", parentId: null, timestamp, type: "message", message: { role: "user", content: "original text", timestamp: 0 } },
    { id: "notice", parentId: "user", timestamp, type: "custom_message", customType: "fixture", display: true, content: "visible notice" },
    { id: "deleted", parentId: "notice", timestamp, type: "message", message: { role: "user", content: "omitted text", timestamp: 0 } },
    { id: "edit", parentId: "deleted", timestamp, type: "context_edit", targetId: "user", replacement: { content: "edited text" } },
    { id: "omit", parentId: "edit", timestamp, type: "context_edit", targetId: "deleted", replacement: null },
  ];
  const history = buildSessionProjection(entries, "omit");
  assert.deepEqual(history.messages.map(message => message.content), ["edited text", "visible notice"]);
  assert.deepEqual(projectedUserCaptures(history.entries), [
    { id: "user", parentId: null, text: "edited text" },
  ]);
});
