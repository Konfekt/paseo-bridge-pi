import assert from "node:assert/strict";
import test from "node:test";
import { dispatchAfterIdlePreflight, IDLE_PREFLIGHT_KEY, IDLE_PROMPT_CANCELLED } from "../extension/idle-preflight.ts";

function isPiRequestAbortError(error: unknown): boolean {
  const value = error as { name?: unknown; message?: unknown };
  const diagnostic = `${String(value?.name ?? "")} ${String(value?.message ?? error)}`;
  return value?.name === "AbortError" || /\brequest was aborted\b|\babort(ed)?\b/i.test(diagnostic);
}

const active = new AbortController().signal;

test("bridge handshake safely dispatches when optional warning extension is absent", async () => {
  let sends = 0;
  const result = await dispatchAfterIdlePreflight(undefined, active, async () => ++sends);
  assert.equal(IDLE_PREFLIGHT_KEY, "__piIdleContextPreflightV1");
  assert.deepEqual(result, { outcome: "unavailable", dispatched: true, value: 1 });
  assert.equal(sends, 1);
});

test("cancellation is authoritative even without the optional warning extension", async () => {
  const result = await dispatchAfterIdlePreflight(undefined, AbortSignal.abort(), async () => assert.fail("must not dispatch"));
  assert.deepEqual(result, { outcome: "cancel", dispatched: false });
});

test("registered extension Cancel stops dispatch; Ignore dispatches once", async () => {
  let sends = 0;
  const cancelled = await dispatchAfterIdlePreflight(
    { ready: true, check: async () => "cancel" as const }, active, async () => ++sends,
  );
  assert.deepEqual(cancelled, { outcome: "cancel", dispatched: false });
  assert.equal(sends, 0);
  assert.equal(isPiRequestAbortError(new Error(IDLE_PROMPT_CANCELLED)), true);

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
