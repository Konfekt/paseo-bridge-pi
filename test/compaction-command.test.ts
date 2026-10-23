import assert from "node:assert/strict";
import test from "node:test";
import { compactWithResult } from "../extension/compaction-command.ts";

test("waits for Pi completion callback and returns its result", async () => {
  let completed = false;
  const context = { compact: (options: any) => setTimeout(() => { completed = true; options.onComplete({ entry: 1 }); }, 10) };
  const result = await compactWithResult(context);
  assert.equal(completed, true);
  assert.deepEqual(result, { entry: 1 });
});

test("rejects callback errors and synchronous dispatch errors", async () => {
  await assert.rejects(compactWithResult({ compact: options => options.onError(new Error("Nothing to compact")) }), /Nothing to compact/);
  await assert.rejects(compactWithResult({ compact: () => { throw new Error("dispatch failed"); } }), /dispatch failed/);
});

test("only the first callback settles the command", async () => {
  const result = await compactWithResult({ compact: options => { options.onComplete("done"); options.onError(new Error("late")); } });
  assert.equal(result, "done");
});
