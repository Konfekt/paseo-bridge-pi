import assert from "node:assert/strict";
import test from "node:test";

import { abortAndWaitForIdle } from "../extension/abort-dispatch.ts";

test("acknowledges an abort that is already settled", async () => {
  let aborted = false;
  const context = {
    abort() {
      aborted = true;
    },
    isIdle() {
      return aborted;
    },
  };

  await abortAndWaitForIdle(context);
  assert.equal(aborted, true);
});

test("waits for Pi to become idle after fire-and-forget abort", async () => {
  let idle = false;
  let polls = 0;
  const context = {
    abort() {},
    isIdle() {
      polls += 1;
      return idle;
    },
  };

  await abortAndWaitForIdle(context, {
    pollMs: 1,
    sleep: async () => {
      idle = true;
    },
  });

  assert.ok(polls >= 2);
});

test("default cancellation remains pending through slow cleanup rather than timing out", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  t.after(() => t.mock.timers.reset());
  let idle = false;
  let waits = 0;
  let aborts = 0;
  await abortAndWaitForIdle({
    abort() { aborts++; },
    isIdle() { return idle; },
  }, {
    sleep: async () => {
      // Advance a controlled clock beyond the former short timeout while the
      // context is still genuinely busy. No wall-clock sleep or provider call.
      t.mock.timers.tick(2000);
      if (++waits === 2) idle = true;
    },
  });
  assert.equal(aborts, 1);
  assert.equal(waits, 2);
});

test("lifetime invalidation never dispatches or acknowledges a successor session", async () => {
  let aborts = 0;
  let idleReads = 0;
  const closed = AbortSignal.abort();
  await assert.rejects(abortAndWaitForIdle({
    abort() { aborts++; }, isIdle() { idleReads++; return true; },
  }, { signal: closed }), /context closed/);
  assert.equal(aborts, 0);
  assert.equal(idleReads, 0);

  const controller = new AbortController();
  let successor = false;
  await assert.rejects(abortAndWaitForIdle({
    abort() { aborts++; }, isIdle() {
      assert.equal(successor, false, 'closed context must not inspect successor idle state');
      idleReads++;
      return false;
    },
  }, { signal: controller.signal, sleep: async () => { successor = true; controller.abort(); } }), /context closed/);
  assert.equal(aborts, 1);
  assert.ok(idleReads > 0, 'the live context was genuinely observed busy before invalidation');
});

test("missing context and synchronous dispatch failures do not claim cancellation settled", async () => {
  await assert.rejects(abortAndWaitForIdle(undefined), /unavailable.*not dispatched/);
  const failure = new Error('abort dispatch failed');
  await assert.rejects(abortAndWaitForIdle({
    abort() { throw failure; }, isIdle() { assert.fail('must not inspect idle after failure'); },
  }), error => error === failure);
  const controller = new AbortController();
  await assert.rejects(abortAndWaitForIdle({
    abort() { controller.abort(); }, isIdle() { assert.fail('lifetime already closed'); },
  }, { signal: controller.signal }), /context closed/);
});

test("fails instead of falsely acknowledging an unsettled abort", async () => {
  const context = {
    abort() {},
    isIdle() {
      return false;
    },
  };

  await assert.rejects(
    abortAndWaitForIdle(context, { timeoutMs: 0 }),
    /Pi did not become idle after cancellation/,
  );
});
