import assert from "node:assert/strict";
import test from "node:test";
import { dispatchAfterIdlePreflight, IDLE_PREFLIGHT_KEY } from "../extension/idle-preflight.ts";

const active = new AbortController().signal;

test("bridge handshake safely dispatches when optional warning extension is absent", async () => {
  let sends = 0;
  const result = await dispatchAfterIdlePreflight(undefined, active, async () => ++sends);
  assert.equal(IDLE_PREFLIGHT_KEY, "__piIdleContextPreflightV1");
  assert.deepEqual(result, { outcome: "unavailable", dispatched: true, value: 1 });
  assert.equal(sends, 1);
});

test("registered extension Cancel stops dispatch; Ignore dispatches once", async () => {
  let sends = 0;
  const cancelled = await dispatchAfterIdlePreflight(
    { ready: true, check: async () => "cancel" as const }, active, async () => ++sends,
  );
  assert.deepEqual(cancelled, { outcome: "cancel", dispatched: false });
  assert.equal(sends, 0);

  const ignored = await dispatchAfterIdlePreflight(
    { ready: true, check: async () => "continue" as const }, active, async () => ++sends,
  );
  assert.deepEqual(ignored, { outcome: "continue", dispatched: true, value: 1 });
  assert.equal(sends, 1);
});

test("aborted and failed preflight never silently dispatch a paid prompt", async () => {
  let sends = 0;
  const controller = new AbortController();
  controller.abort();
  const aborted = await dispatchAfterIdlePreflight({ ready: true, check: async () => "continue" as const }, controller.signal, async () => ++sends);
  const failed = await dispatchAfterIdlePreflight({ ready: true, check: async () => { throw new Error("dialog failed"); } }, active, async () => ++sends);
  const notReady = await dispatchAfterIdlePreflight({ ready: false, check: async () => "continue" as const }, active, async () => ++sends);
  assert.equal(aborted.dispatched, false);
  assert.equal(failed.dispatched, false);
  assert.equal(notReady.dispatched, false);
  assert.equal(sends, 0);
});

test("lifecycle abort settles even a broken capability that ignores cancellation", async () => {
  const controller = new AbortController();
  const capability = { ready: true, check: () => new Promise<"continue">(() => {}) };
  const result = dispatchAfterIdlePreflight(capability, controller.signal, async () => assert.fail("must not dispatch"));
  controller.abort();
  assert.equal((await result).outcome, "cancel");
});
