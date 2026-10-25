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
