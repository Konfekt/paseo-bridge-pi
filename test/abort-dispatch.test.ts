import assert from "node:assert/strict";
import test from "node:test";

import { abortAndAcknowledge, waitForSettlement } from "../extension/abort-dispatch.ts";

test("acknowledges an abort that settles at once", async () => {
  let aborted = false;
  const outcome = await abortAndAcknowledge({ abort() { aborted = true; }, isIdle() { return aborted; } });
  assert.equal(aborted, true);
  assert.equal(outcome.settled, true);
  await outcome.idle;
});

test("waits briefly for Pi to become idle after fire-and-forget abort", async () => {
  let idle = false;
  setTimeout(() => { idle = true; }, 20);
  const outcome = await abortAndAcknowledge({ abort() {}, isIdle() { return idle; } }, { pollMs: 1, acknowledgeWithinMs: 1000 });
  assert.equal(outcome.settled, true);
});

// Paseo refuses to stop or replace the agent when the interrupt is not answered
// within two seconds, so slow tool cleanup must not hold the acknowledgement.
test("acknowledges within the deadline while a tool is still stopping, then reports settlement", async () => {
  let idle = false;
  const started = Date.now();
  const outcome = await abortAndAcknowledge({ abort() {}, isIdle() { return idle; } }, { pollMs: 1, acknowledgeWithinMs: 30 });
  assert.equal(outcome.settled, false);
  assert.ok(Date.now() - started < 1000);
  assert.equal(await waitForSettlement(outcome.idle, 10), false, "still busy at a short deadline");
  idle = true;
  assert.equal(await waitForSettlement(outcome.idle, 1000), true, "settlement is observed once Pi is idle");
});

test("the default acknowledgement stays inside Paseo's two-second interrupt window", async () => {
  const started = Date.now();
  const outcome = await abortAndAcknowledge({ abort() {}, isIdle() { return false; } });
  const elapsed = Date.now() - started;
  assert.equal(outcome.settled, false);
  assert.ok(elapsed < 2000, `acknowledged after ${elapsed} ms`);
});

test("lifetime invalidation never dispatches or reports a successor session idle", async () => {
  let aborts = 0;
  let idleReads = 0;
  await assert.rejects(abortAndAcknowledge({
    abort() { aborts++; }, isIdle() { idleReads++; return true; },
  }, { signal: AbortSignal.abort() }), /context closed/);
  assert.equal(aborts, 0);
  assert.equal(idleReads, 0);

  const controller = new AbortController();
  let successor = false;
  const outcome = await abortAndAcknowledge({
    abort() { aborts++; },
    isIdle() {
      assert.equal(successor, false, "closed context must not inspect successor idle state");
      idleReads++;
      return false;
    },
  }, { signal: controller.signal, pollMs: 1, acknowledgeWithinMs: 10 });
  assert.equal(outcome.settled, false);
  successor = true;
  controller.abort();
  await assert.rejects(outcome.idle, /context closed/);
  assert.equal(aborts, 1);
  assert.ok(idleReads > 0);
});

test("missing context and synchronous dispatch failures do not claim cancellation", async () => {
  await assert.rejects(abortAndAcknowledge(undefined), /unavailable.*not dispatched/);
  const failure = new Error("abort dispatch failed");
  await assert.rejects(abortAndAcknowledge({
    abort() { throw failure; }, isIdle() { assert.fail("must not inspect idle after failure"); },
  }), error => error === failure);
});
