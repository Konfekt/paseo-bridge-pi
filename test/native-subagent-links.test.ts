import assert from "node:assert/strict";
import test from "node:test";
import { NativeSubagentLinks, NATIVE_SUBAGENTS_MARKER, type NativeSessionSource } from "../extension/native-subagent-links.ts";

const taskId = `subagent-task-${"a".repeat(24)}`;
const childId = `subagent-child-${"b".repeat(24)}`;
const source: NativeSessionSource = { taskId, childId, groupId: `subagent-job-${"c".repeat(24)}`, attempt: 1,
  runtimeId: "owned-runtime", status: "completed", sessionFile: "/private/owned/session.jsonl" };
const args = { task: "inspect", agent: "scout" };
const result = { content: [{ type: "text", text: "done" }], details: { task_id: taskId, child_id: childId, attempt: 1,
  task: "inspect", mode: "single", results: [{ agent: "scout", success: true }] } };
const history = () => [
  { role: "assistant", content: [{ type: "toolCall", id: "old-call::paseo-child::0", name: "subagent", arguments: args }] },
  { role: "toolResult", toolCallId: "old-call::paseo-child::0", toolName: "subagent", ...structuredClone(result) },
];
const decode = (s: string) => JSON.parse(s.slice(NATIVE_SUBAGENTS_MARKER.length));

test("reconciles historical records with authoritative native status and retained source", async () => {
  const links = new NativeSubagentLinks(); links.seed(history());
  const [message] = await links.notifications(async input => { assert.deepEqual(input, { taskId, childId, attempt: 1 }); return { ...source, operatorCapability: "private" } as any; });
  const b = decode(message).bindings[0];
  assert.equal(b.id, "old-call::paseo-child::0"); assert.equal(b.status, "completed");
  assert.equal(b.sessionFile, source.sessionFile); assert.equal(b.runtimeId, source.runtimeId);
  assert.equal("operatorCapability" in b, false);
  assert.deepEqual(await links.notifications(async () => source), []);
  links.resetDelivery(); assert.equal((await links.notifications(async () => source)).length, 1);
  links.clear(); assert.deepEqual(await links.notifications(async () => source), []);
});

test("publishes completed status without transcript, then attaches the later validated transcript", async () => {
  const links = new NativeSubagentLinks(); links.seed(history());
  const statusOnly = { ...source, sessionFile: undefined };
  const [first] = await links.notifications(async () => statusOnly);
  const initial = decode(first).bindings[0];
  assert.equal(initial.status, "completed"); assert.equal("sessionFile" in initial, false);
  assert.deepEqual(await links.notifications(async () => ({ ...source, sessionFile: "/arbitrary/path" })), [], "status-only cache must not short-circuit a later transcript refresh");
  links.resetDelivery();
  const [recovered] = await links.notifications(async () => source);
  assert.equal(decode(recovered).bindings[0].sessionFile, source.sessionFile);
});

test("enriches daemon history without modifying model-visible messages", async () => {
  const links = new NativeSubagentLinks(); const messages = history();
  const enriched = await links.enrichHistory(messages, async () => source);
  assert.equal((enriched[1] as any).details.results[0].sessionFile, source.sessionFile);
  assert.equal("sessionFile" in (messages[1] as any).details.results[0], false);
});

for (const bad of [
  { childId: `subagent-child-${"d".repeat(24)}` }, { taskId: `subagent-task-${"d".repeat(24)}` },
  { attempt: 2 }, { sessionFile: "relative/session.jsonl" }, { status: "reaped" }, { runtimeId: 3 },
]) test(`rejects an invalid or mismatched source: ${JSON.stringify(bad)}`, async () => {
  const links = new NativeSubagentLinks(); links.seed(history());
  assert.deepEqual(await links.notifications(async () => ({ ...source, ...bad }) as any), []);
});

test("does not guess paths or bind lifecycle calls, missing IDs, or foreign source failures", async () => {
  const links = new NativeSubagentLinks();
  links.seed([{ role: "assistant", content: [{ type: "toolCall", id: "lifecycle", name: "subagent", arguments: { ...args, operation: "result" } }] },
    { role: "toolResult", toolName: "subagent", toolCallId: "lifecycle", ...result }]);
  let calls = 0; assert.deepEqual(await links.notifications(async () => { calls++; return source; }), []); assert.equal(calls, 0);
  links.seed(history()); assert.deepEqual(await links.notifications(async () => { throw Error("wrong owner"); }), []);
});

test("live foreground and single-child background sources use their existing stable IDs", async () => {
  for (const background of [false, true]) {
    const links = new NativeSubagentLinks();
    links.observe({ type: "tool_execution_start", toolName: "subagent", toolCallId: "existing", args: { ...args, background } });
    links.observe({ type: "tool_execution_end", toolName: "subagent", toolCallId: "existing", result: background
      ? { details: { tui_subagent: true, group: { children: [{ task_id: taskId, child_id: childId, attempt: 1 }] } } } : result });
    assert.equal(decode((await links.notifications(async () => source))[0]).bindings[0].id, "existing");
  }
});

test("notification batches remain bounded and do not reject ordinary multiline task descriptions", async () => {
  const links = new NativeSubagentLinks();
  for (let i = 0; i < 150; i++) {
    const id = `call-${i}`;
    links.observe({ type: "tool_execution_start", toolName: "subagent", toolCallId: id, args: { agent: "scout", task: "\ninspect\n" } });
    links.observe({ type: "tool_execution_end", toolName: "subagent", toolCallId: id, result });
  }
  const messages = await links.notifications(async () => source);
  assert(messages.length >= 2);
  assert.equal(messages.flatMap(m => decode(m).bindings).length, 150);
  for (const message of messages) {
    assert(Buffer.byteLength(message) < 49 * 1024);
    assert(decode(message).bindings.length <= 128);
    assert(decode(message).bindings.every((b: any) => b.task === "inspect"));
  }
});

test("a connection/owner epoch change discards in-flight reconciliation and allows fresh delivery", async () => {
  const links = new NativeSubagentLinks(); links.seed(history());
  let release!: (s: NativeSessionSource) => void;
  const pending = links.notifications(() => new Promise(resolve => { release = resolve; }));
  links.resetDelivery(); release(source);
  assert.deepEqual(await pending, []);
  assert.equal((await links.notifications(async () => source)).length, 1);
});

test("source lookup recovers after prolonged unavailability without a reload", async () => {
  let now = 0;
  const links = new NativeSubagentLinks(() => now); links.seed(history());
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(await links.notifications(async () => { throw Error("manifest not ready"); }), []);
    now += 11000;
  }
  assert.equal((await links.notifications(async () => source)).length, 1);
});

test("history revalidates a previously cached source rather than blindly reusing its path", async () => {
  const links = new NativeSubagentLinks(); links.seed(history());
  await links.notifications(async () => source);
  const output = await links.enrichHistory(history(), async () => { throw Error("source no longer owned"); });
  assert.equal("sessionFile" in (output[1] as any).details.results[0], false);
});
