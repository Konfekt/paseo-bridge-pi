import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NativeSubagentLinks } from "../extension/native-subagent-links.ts";
import { SubagentTaskProjection, projectSubagentMessages } from "../extension/subagent-task-projection.ts";

// Point at the installed Paseo pi-subagents adapter to exercise the actual
// consumer, not a mock which merely trusts the tool-call completion flag.
const consumerModule = process.env.PASEO_SUBAGENT_ADAPTER_MODULE;
test("actual Paseo consumer settles projected native subagents in live and history paths", { skip: !consumerModule }, async () => {
  const { piSubagents } = await import(pathToFileURL(consumerModule!).href);
  const args = { agent: "scout", task: "read-only check" };
  for (const failed of [false, true]) {
    const result = { content: [{ type: "text", text: "worker report" }], details: {
      tui_subagent: true, backend: "native", failed,
      group: { children: [{ child: 1, task: args.task, status: failed ? "failed" : "completed" }] },
    } };
    const projector = new SubagentTaskProjection();
    const [start] = projector.project({ type: "tool_execution_start", toolCallId: "call", toolName: "subagent", args });
    const [end] = projector.project({ type: "tool_execution_end", toolCallId: "call", toolName: "subagent", result, isError: failed });
    const history = projectSubagentMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "subagent", arguments: args }] },
      { role: "toolResult", toolCallId: "call", toolName: "subagent", ...result, isError: failed },
    ]) as any[];
    for (const completion of [end.result, history[1]]) {
      const session = piSubagents.createSession();
      const running = session.mapToolCall({ callId: start.toolCallId, toolName: "subagent", args: start.args, status: "running", result: null });
      assert.equal(running.subagents[0].status, "running");
      const settled = session.mapToolCall({ callId: start.toolCallId, toolName: "subagent", args: start.args, status: failed ? "failed" : "completed", result: completion });
      assert.equal(settled.subagents?.[0]?.status, failed ? "failed" : "completed", "tool completed but the separate subagent registry did not settle");
      assert.equal(settled.subagents[0].id, running.subagents[0].id);
    }
  }
});

for (const failed of [false, true]) test(`actual consumer reconciles ${failed ? "failed" : "completed"} status before transcript recovery`, { skip: !consumerModule }, async () => {
  const url = pathToFileURL(consumerModule!);
  const [{ piSubagents }, { PiExtensionHost }, { PiRpcAgentSession }, { ProviderSubagentStore }] = await Promise.all([
    import(url.href), import(new URL("../host.js", url).href), import(new URL("../../agent.js", url).href),
    import(new URL("../../../../provider-subagents/store.js", url).href),
  ]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-status-recovery-"));
  const file = path.join(directory, "session.jsonl");
  await fs.chmod(directory, 0o700);
  await fs.writeFile(file, [
    { type: "session", version: 3, id: "fixture", cwd: directory },
    { type: "message", id: "answer", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }], stopReason: "stop" } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
  const host = new PiExtensionHost([piSubagents]);
  try {
    const store = new ProviderSubagentStore();
    const hydration: Promise<any>[] = [];
    const apply = (mapping: any) => {
      for (const event of mapping?.events ?? []) if (event.type === "provider_subagent") store.apply("parent", "pi", event.event);
      if (mapping?.hydration) hydration.push(mapping.hydration.then((events: any[]) => {
        for (const event of events) if (event.type === "provider_subagent") store.apply("parent", "pi", event.event);
      }));
    };
    const args = { agent: "scout", task: "inspect" };
    apply(host.mapToolCall({ callId: "stable-worker-id", toolName: "subagent", args, status: "running", result: null }));
    apply(host.mapToolCall({ callId: "stable-worker-id", toolName: "subagent", args, status: failed ? "failed" : "completed", result: { content: [{ type: "text", text: "done" }], details: {} } }));
    assert.equal(store.get("parent", "stable-worker-id").status, failed ? "failed" : "running");
    const taskId = `subagent-task-${"a".repeat(24)}`, childId = `subagent-child-${"b".repeat(24)}`;
    const links = new NativeSubagentLinks();
    links.seed([
      { role: "assistant", content: [{ type: "toolCall", id: "stable-worker-id", name: "subagent", arguments: args }] },
      { role: "toolResult", toolName: "subagent", toolCallId: "stable-worker-id", details: { task_id: taskId, child_id: childId, attempt: 1 } },
    ]);
    const resolve = async (withFile: boolean) => ({ taskId, childId, groupId: `subagent-job-${"c".repeat(24)}`,
      attempt: 1, runtimeId: "owned-runtime", status: failed ? "failed" as const : "completed" as const,
      ...(withFile ? { sessionFile: file } : {}) });
    const context = { extensionHost: host, currentTurnIdForEvent: () => undefined, emitExtensionOutput: apply,
      emit: () => assert.fail("private linkage must not emit a UI notification or parent completion") };
    const handler = (PiRpcAgentSession.prototype as any).handleExtensionUiRequest;
    // Model daemon replacement: a stale history prime exists in the new host/store,
    // while the same Pi runtime still has an old connection's resolver in flight.
    let releasePrevious!: (source: Awaited<ReturnType<typeof resolve>>) => void;
    const previousConnection = links.notifications(() => new Promise(resolve => { releasePrevious = resolve; }));
    await Promise.resolve();
    links.resetDelivery();
    const reconnectedPublication = links.notifications(() => resolve(false));
    releasePrevious(await resolve(false));
    assert.deepEqual(await previousConnection, [], "old connection epoch must not publish into the replacement daemon");
    const [statusMessage] = await reconnectedPublication;
    handler.call(context, { method: "paseo_native_subagents", message: statusMessage });
    await Promise.all(hydration);
    assert.equal(store.get("parent", "stable-worker-id").status, failed ? "failed" : "completed");
    assert.equal(store.fetchTimeline("parent", "stable-worker-id", { direction: "tail", limit: 100 }).rows.length, 0, "unavailable transcript must not hydrate rows");
    links.resetDelivery();
    const [historyMessage] = await links.notifications(() => resolve(true));
    handler.call(context, { method: "paseo_native_subagents", message: historyMessage });
    await Promise.all(hydration);
    const rows = store.fetchTimeline("parent", "stable-worker-id", { direction: "tail", limit: 100 }).rows;
    assert(rows.length > 0);
    assert.match(JSON.stringify(rows), /Recovered answer/);
    assert.equal(store.get("parent", "stable-worker-id").id, "stable-worker-id", "transcript recovery must reuse worker identity");
    handler.call(context, { method: "paseo_native_subagents", message: historyMessage });
    await Promise.all(hydration);
    assert.equal(store.fetchTimeline("parent", "stable-worker-id", { direction: "tail", limit: 100 }).rows.length, rows.length, "reconnect snapshot must not duplicate transcript rows");
    const spoofLinks = new NativeSubagentLinks();
    spoofLinks.seed([
      { role: "assistant", content: [{ type: "toolCall", id: "spoof-id", name: "subagent", arguments: args }] },
      { role: "toolResult", toolName: "subagent", toolCallId: "spoof-id", details: { task_id: taskId, child_id: childId, attempt: 1 } },
    ]);
    assert.deepEqual(await spoofLinks.notifications(async () => ({ ...await resolve(true), taskId: `subagent-task-${"d".repeat(24)}` } as any)), [], "foreign task identity must not publish a binding");
  } finally { host.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("explicit reap hides native subagent inventory but retains direct transcript access", { skip: !consumerModule }, async () => {
  const url = pathToFileURL(consumerModule!);
  const [{ piSubagents }, { PiExtensionHost }, { PiRpcAgentSession }, { ProviderSubagentStore }] = await Promise.all([
    import(url.href), import(new URL("../host.js", url).href), import(new URL("../../agent.js", url).href),
    import(new URL("../../../../provider-subagents/store.js", url).href),
  ]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-reaped-list-"));
  const file = path.join(directory, "session.jsonl");
  await fs.chmod(directory, 0o700);
  await fs.writeFile(file, [
    { type: "session", version: 3, id: "fixture", cwd: directory },
    { type: "message", id: "retained", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Retained after reap" }], stopReason: "stop" } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  let host = new PiExtensionHost([piSubagents]);
  try {
    let store = new ProviderSubagentStore();
    const rows = [
      { taskId: `subagent-task-${"a".repeat(24)}`, childId: `subagent-child-${"b".repeat(24)}`, attempt: 1,
        runtimeId: "owned-runtime", status: "completed" as const },
      { taskId: `subagent-task-${"c".repeat(24)}`, childId: `subagent-child-${"d".repeat(24)}`, attempt: 1,
        runtimeId: "probe-runtime", status: "completed" as const },
    ];
    let now = 0;
    const links = new NativeSubagentLinks(() => now);
    const reaped = new Set<string>();
    const args = { agent: "scout", task: "inspect" };
    for (const [index, row] of rows.entries()) {
      const id = `worker-${index}`;
      links.seed([
        { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: args }] },
        { role: "toolResult", toolName: "subagent", toolCallId: id, details: { task_id: row.taskId, child_id: row.childId, attempt: row.attempt } },
      ]);
    }
    const resolve = async ({ taskId, childId, attempt }: any) => {
      const row = rows.find(value => value.taskId === taskId && value.childId === childId && value.attempt === attempt);
      return row ? { ...row, reaped: reaped.has(row.runtimeId), groupId: `subagent-job-${"e".repeat(24)}`, sessionFile: file } : undefined;
    };
    const live: any[] = [];
    const apply = async (messages: string[]) => {
      const hydration: Promise<any>[] = [];
      const consume = (events: any[]) => {
        for (const event of events) if (event.type === "provider_subagent") live.push(store.apply("parent", "pi", event.event));
      };
      const context = { extensionHost: host, currentTurnIdForEvent: () => undefined,
        emitExtensionOutput: (mapping: any) => {
          consume(mapping?.events ?? []);
          if (mapping?.hydration) hydration.push(mapping.hydration.then(consume));
        }, emit: () => assert.fail("private linkage must not emit UI notifications") };
      for (const message of messages) (PiRpcAgentSession.prototype as any).handleExtensionUiRequest.call(context,
        { method: "paseo_native_subagents", message });
      await Promise.all(hydration);
    };
    await apply(await links.notifications(resolve));
    assert.deepEqual(store.list("parent").map(item => item.id).sort(), ["worker-0", "worker-1"]);
    reaped.add("owned-runtime");
    live.length = 0;
    now += 11000;
    await apply(await links.notifications(resolve));
    assert.deepEqual(store.list("parent").map(item => item.id), ["worker-1"], "reaped worker disappears while completed probe remains visible");
    assert(live.some(event => event.type === "remove" && event.subagentId === "worker-0"), "live clients receive the standard removal");
    assert.equal(store.get("parent", "worker-0")?.status, "completed", "reaping does not alter execution status");
    const transcript = store.fetchTimeline("parent", "worker-0", { direction: "tail", limit: 10 }).rows;
    assert(transcript.length > 0, "retained direct conversation timeline survives hiding");
    assert.match(JSON.stringify(transcript), /Retained after reap/);
    host.close();
    host = new PiExtensionHost([piSubagents]);
    store = new ProviderSubagentStore();
    links.resetDelivery();
    await apply(await links.notifications(resolve));
    assert.match(JSON.stringify(store.fetchTimeline("parent", "worker-0", { direction: "tail", limit: 10 }).rows), /Retained after reap/);
    assert.deepEqual(store.list("parent").map(item => item.id), ["worker-1"], "replacement daemon keeps exact reaped binding hidden");
    assert.equal(store.get("parent", "worker-0")?.status, "completed");
    store.apply("parent", "pi", { type: "upsert", id: "worker-0", status: "completed" });
    assert.deepEqual(store.listAll().map(item => item.id), ["worker-1"], "late history cannot resurrect a hidden entry");
    store.deleteParent("parent");
    assert.equal(store.get("parent", "worker-0"), null);
  } finally { host.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

for (const follow of [false, true]) test(`private native reconciliation repairs the real registry and loads retained conversation rows (${follow ? "live follower" : "history hydration"})`, { skip: !consumerModule }, async () => {
  const url = pathToFileURL(consumerModule!);
  const [{ piSubagents }, { PiExtensionHost }, { PiRpcAgentSession }, { ProviderSubagentStore }] = await Promise.all([
    import(url.href), import(new URL("../host.js", url).href), import(new URL("../../agent.js", url).href),
    import(new URL("../../../../provider-subagents/store.js", url).href),
  ]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-conversation-"));
  const file = path.join(directory, "session.jsonl");
  await fs.chmod(directory, 0o700);
  await fs.writeFile(file, [
    { type: "session", version: 3, id: "fixture", cwd: directory },
    { type: "message", id: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Inspect the fixture" } },
    { type: "message", id: "answer", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Retained worker answer" }], stopReason: "stop" } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
  const host = new PiExtensionHost([piSubagents]);
  try {
    const store = new ProviderSubagentStore();
    const hydration: Promise<any>[] = [];
    const apply = (mapping: any) => {
      for (const event of mapping?.events ?? []) if (event.type === "provider_subagent") store.apply("parent", "pi", event.event);
      if (mapping?.hydration) hydration.push(mapping.hydration.then((events: any[]) => {
        for (const event of events) if (event.type === "provider_subagent") store.apply("parent", "pi", event.event);
      }));
    };
    if (follow) host.follow((event: any) => {
      if (event.type === "provider_subagent") store.apply("parent", "pi", event.event);
    });
    const args = { agent: "scout", task: "inspect" };
    apply(host.mapToolCall({ callId: "old::paseo-child::0", toolName: "subagent", args, status: "running", result: null }));
    apply(host.mapToolCall({ callId: "old::paseo-child::0", toolName: "subagent", args, status: "completed", result: { content: [{ type: "text", text: "done" }], details: {} } }));
    assert.equal(store.get("parent", "old::paseo-child::0").status, "running", "negative control must reproduce stale registry");
    const taskId = `subagent-task-${"a".repeat(24)}`, childId = `subagent-child-${"b".repeat(24)}`;
    const links = new NativeSubagentLinks();
    links.seed([
      { role: "assistant", content: [{ type: "toolCall", id: "old::paseo-child::0", name: "subagent", arguments: args }] },
      { role: "toolResult", toolName: "subagent", toolCallId: "old::paseo-child::0", details: { task_id: taskId, child_id: childId, attempt: 1 } },
    ]);
    const [message] = await links.notifications(async () => ({ taskId, childId, groupId: `subagent-job-${"c".repeat(24)}`,
      attempt: 1, runtimeId: "owned", status: "completed", sessionFile: file }));
    const context = { extensionHost: host, currentTurnIdForEvent: () => undefined, emitExtensionOutput: apply,
      emit: () => assert.fail("private linkage must not emit a UI notification or parent completion") };
    const handler = (PiRpcAgentSession.prototype as any).handleExtensionUiRequest;
    handler.call(context, { method: "notify", message });
    assert.equal(store.get("parent", "old::paseo-child::0").status, "running", "ordinary notification text must not authorize a file read");
    handler.call(context, { method: "paseo_native_subagents", message });
    await Promise.all(hydration);
    assert.equal(store.get("parent", "old::paseo-child::0").status, "completed");
    const rows = store.fetchTimeline("parent", "old::paseo-child::0", { direction: "tail", limit: 100 }).rows;
    assert(rows.length > 0, "clicking the pill must have actual conversation rows");
    assert.match(JSON.stringify(rows), /Retained worker answer/);
    handler.call(context, { method: "paseo_native_subagents", message });
    await Promise.all(hydration);
    assert.equal(store.fetchTimeline("parent", "old::paseo-child::0", { direction: "tail", limit: 100 }).rows.length, rows.length, "reconciliation must not duplicate the transcript");
  } finally { host.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
