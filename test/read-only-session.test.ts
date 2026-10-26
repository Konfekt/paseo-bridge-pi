import test from "node:test";
import assert from "node:assert/strict";
import { sameReadOnlySession } from "../extension/read-only-session.ts";

const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id } });

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
