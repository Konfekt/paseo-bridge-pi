import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
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
