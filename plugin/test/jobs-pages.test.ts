import assert from "node:assert/strict";
import test from "node:test";
import { readJobs } from "../client/jobs-pages.ts";
test("jobs exhaust pages and deduplicate exact IDs without dropping descendant rows", async () => {
  const calls: Array<string | undefined> = [];
  const page = await readJobs(async cursor => {
    calls.push(cursor);
    return { sessionId: "owner", state: "available", items: cursor ? [{ jobId: "same" }, { jobId: "grandchild", fromSubagent: true }] : [{ jobId: "direct" }, { jobId: "same" }], nextCursor: cursor ? undefined : "page2" };
  });
  assert.deepEqual(calls, [undefined, "page2"]);
  assert.deepEqual(page.items.map(item => item.jobId), ["direct", "same", "grandchild"]);
  assert.equal(page.nextCursor, undefined);
});
test("jobs fail visibly on cycles or changed owner, never return partial inventories", async () => {
  await assert.rejects(readJobs(async () => ({ sessionId: "owner", state: "available", items: [], nextCursor: "cycle" })), /pagination/);
  await assert.rejects(readJobs(async cursor => ({ sessionId: cursor ? "other" : "owner", state: "available", items: [], nextCursor: cursor ? undefined : "next" })), /changed/);
});
