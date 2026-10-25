import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { SubagentTaskProjection, projectSubagentMessages } from "../extension/subagent-task-projection.ts";

// Production Nix check supplies the actual compiled server, not a mock adapter.
const consumerModule = process.env.PASEO_SUBAGENT_ADAPTER_MODULE;
async function production() {
  const url = pathToFileURL(consumerModule!);
  const [{ piExtensions }, { PiExtensionHost }, { PiRpcAgentSession }, { ProviderSubagentStore }] = await Promise.all([
    import(new URL("../registry.js", url).href), import(new URL("../host.js", url).href), import(new URL("../../agent.js", url).href),
    import(new URL("../../../../provider-subagents/store.js", url).href),
  ]);
  const host = new PiExtensionHost(piExtensions);
  const store = new ProviderSubagentStore();
  const apply = (mapping: any) => {
    assert.deepEqual(mapping?.childSessions ?? [], [], "Work workers must never start native transcript readers");
    for (const event of mapping?.events ?? []) if (event.type === "provider_subagent") {
      assert.notEqual(event.event.type, "upsert", "Work workers must never register native descriptors");
      store.apply("parent", "pi", event.event);
    }
  };
  return { host, store, apply, PiRpcAgentSession };
}

for (const args of [
  { agent: "scout", task: "inspect" },
  { tasks: [{ agent: "scout", task: "one" }, { agent: "reviewer", task: "two" }] },
  { chain: [{ agent: "scout", task: "one" }, { agent: "reviewer", task: "two" }] },
  { agent: "scout", task: "background", background: true },
  { operation: "resume", task_id: `subagent-task-${"a".repeat(24)}` },
]) for (const failed of [false, true]) {
  test(`production admission suppressed for live/history/reconnect ${JSON.stringify(args)} failed=${failed}`, { skip: !consumerModule }, async () => {
    const { host, store, apply } = await production();
    try {
      const result = { content: [{ type: "text", text: failed ? "Exact worker failure" : "Retained worker answer" }], details: {
        tui_subagent: true, backend: "native", failed,
        group: { children: [1, 2].map(child => ({ child, status: failed ? "failed" : "completed", final: failed ? "Exact worker failure" : "Retained worker answer" })) },
      } };
      const projector = new SubagentTaskProjection();
      const starts = projector.project({ type: "tool_execution_start", toolCallId: "call", toolName: "subagent", args });
      const ends = projector.project({ type: "tool_execution_end", toolCallId: "call", toolName: "subagent", result, isError: failed });
      for (const start of starts) {
        apply(host.mapToolCall({ callId: start.toolCallId, toolName: "subagent", args: start.args, status: "running", result: null }));
        assert.deepEqual(store.list("parent"), []);
        const end = ends.find(event => event.toolCallId === start.toolCallId)!;
        const mapping = host.mapToolCall({ callId: start.toolCallId, toolName: "subagent", args: start.args, status: failed ? "failed" : "completed", result: end.result });
        apply(mapping);
        const detail = mapping.detail;
        assert.doesNotMatch(JSON.stringify(detail), /_paseoWorkAgent/);
        assert.match(JSON.stringify(detail), failed ? /Exact worker failure/ : /Retained worker answer/);
      }
      const history = projectSubagentMessages([
        { role: "assistant", content: [{ type: "toolCall", id: "call", name: "subagent", arguments: args }] },
        { role: "toolResult", toolCallId: "call", toolName: "subagent", ...result, isError: failed },
      ]) as any[];
      for (let reconnect = 0; reconnect < 2; reconnect++) {
        for (const call of history[0].content) {
          const result = history.find(message => message.toolCallId === call.id);
          apply(host.mapToolCall({ callId: call.id, toolName: "subagent", args: call.arguments, status: failed ? "failed" : "completed", result }));
        }
        assert.deepEqual(store.list("parent"), []);
        assert.deepEqual(store.listAll(), []);
      }
    } finally { host.close(); }
  });
}

for (const toolName of ["subagent", "Agent"]) {
  test(`unrelated native ${toolName} survives actual live/history projection and full registry`, { skip: !consumerModule }, async () => {
    const { host, store } = await production();
    try {
      const args = { subagent_type: "research", prompt: "Investigate independently" };
      const start = { type: "tool_execution_start", toolCallId: "unrelated", toolName, args };
      const [live] = new SubagentTaskProjection().project(start);
      assert.deepEqual(live, start);
      const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "unrelated", name: toolName, arguments: args }] }];
      const history = projectSubagentMessages(messages) as any[];
      assert.deepEqual(history, messages);
      for (const projectedArgs of [live.args, history[0].content[0].arguments]) {
        const mapping = host.mapToolCall({ callId: "unrelated", toolName, args: projectedArgs, status: "running", result: null });
        assert(mapping.events.some((event: any) => event.type === "provider_subagent" && event.event.type === "upsert"));
        assert(!mapping.events.some((event: any) => event.type === "provider_subagent" && event.event.type === "hide"));
        for (const event of mapping.events) if (event.type === "provider_subagent") store.apply("parent", "pi", event.event);
        assert.equal(store.list("parent").length, 1);
      }
    } finally { host.close(); }
  });
}

test("legacy and already-loaded descriptors retire without deleting retained timelines or other providers", { skip: !consumerModule }, async () => {
  const { host, store, apply, PiRpcAgentSession } = await production();
  try {
    const oldId = "old::paseo-child::0";
    for (const [id, provider] of [[oldId, "pi"], ["legacy-binding", "pi"], ["independent", "pi"], ["other-provider", "claude"]]) {
      store.apply("parent", provider, { type: "upsert", id, title: id, status: "completed" });
      store.apply("parent", provider, { type: "timeline", id, item: { type: "assistant_message", text: `Retained ${id}` } });
    }
    const before = store.fetchTimeline("parent", oldId, { direction: "tail", limit: 100 });
    apply(host.mapToolCall({ callId: oldId, toolName: "subagent", args: { agent: "scout", task: "old unmarked history" }, status: "running", result: null }));
    const message = "PI_NATIVE_SUBAGENTS_V1:" + JSON.stringify({ version: 1, bindings: [{
      id: "legacy-binding", taskId: `subagent-task-${"a".repeat(24)}`, childId: `subagent-child-${"b".repeat(24)}`,
      attempt: 1, runtimeId: "owned", status: "completed", agent: "scout", sessionFile: "/must-not-be-read/session.jsonl",
    }] });
    const context = { extensionHost: host, currentTurnIdForEvent: () => undefined, emitExtensionOutput: apply,
      emit: () => assert.fail("private protocol must not emit UI notifications") };
    const handler = (PiRpcAgentSession.prototype as any).handleExtensionUiRequest;
    for (let reconnect = 0; reconnect < 2; reconnect++) handler.call(context, { method: "paseo_native_subagents", message });
    assert.deepEqual(store.list("parent").map((row: any) => row.id).sort(), ["independent", "other-provider"]);
    assert.deepEqual(store.fetchTimeline("parent", oldId, { direction: "tail", limit: 100 }), before);
    assert.match(JSON.stringify(store.fetchTimeline("parent", "legacy-binding", { direction: "tail", limit: 100 })), /Retained legacy-binding/);
    // Unrelated native Pi integrations still register normally.
    const native = host.mapToolCall({ callId: "third-party", toolName: "subagent", args: { agent: "native", task: "unrelated" }, status: "running", result: null });
    assert(native.events.some((event: any) => event.type === "provider_subagent" && event.event.type === "upsert"));
  } finally { host.close(); }
});
