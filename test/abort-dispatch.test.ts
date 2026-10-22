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
    timeoutMs: 100,
    pollMs: 1,
    sleep: async () => {
      idle = true;
    },
  });

  assert.ok(polls >= 2);
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
    abort() { aborts++; }, isIdle() { idleReads++; return successor; },
  }, { signal: controller.signal, sleep: async () => { successor = true; controller.abort(); } }), /context closed/);
  assert.equal(aborts, 1);
  assert.equal(idleReads, 2, 'closed context must not read successor idle state');
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
