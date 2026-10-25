import assert from "node:assert/strict";
import test from "node:test";
import { SubagentTaskProjection, projectSubagentMessages } from "../extension/subagent-task-projection.ts";

function project(args: any, result: any, isError = false) {
  const projection = new SubagentTaskProjection();
  projection.project({ type: "tool_execution_start", toolCallId: "native", toolName: "subagent", args });
  const live = projection.project({ type: "tool_execution_end", toolCallId: "native", toolName: "subagent", result, isError });
  const history = projectSubagentMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "native", name: "subagent", arguments: args }] },
    { role: "toolResult", toolCallId: "native", toolName: "subagent", ...result, isError },
  ]) as any[];
  return [live.map(event => ({ ...event.result, isError: event.isError })), history.slice(1)];
}

function native(children: any[], failed = false, report = "Worker report") {
  return {
    content: [{ type: "text", text: report }],
    details: { tui_subagent: true, backend: "native", operation: "result", failed,
      group: { status: failed ? "failed" : "completed", mode: "single", children } },
  };
}

test("native named-profile success stays successful in live and historical projection", () => {
  // Shape captured from the deployed scout smoke test: no legacy results[].
  const result = native([{ child: 1, child_id: "child-a", task_id: `subagent-task-${"a".repeat(24)}`,
    status: "completed", task: "inspect profiles", attempt: 1,
    task_outcome: { state: "delivered", reported: true, summary: "Source map completed" },
    cwd: "/private/workspace", operatorCapability: "must-not-leak" }], false, "Verified discovery and retained-resume source map");
  for (const projected of project({ task: "inspect profiles", agent: "scout", background: false }, result)) {
    assert.equal(projected.length, 1);
    assert.equal(projected[0].isError, false);
    assert.equal(projected[0].details.mode, "single");
    assert.deepEqual(projected[0].details.results, [{ agent: "scout", success: true }]);
    assert.match(projected[0].content[0].text, /Verified discovery and retained-resume source map/);
    assert.doesNotMatch(projected[0].content[0].text, /Subagent did not start/);
    assert.equal(projected[0].details.task_id, `subagent-task-${"a".repeat(24)}`);
    assert.equal("operatorCapability" in projected[0].details, false);
    assert.equal("cwd" in projected[0].details, false);
  }
});

for (const status of ["failed", "cancelled", "lost"]) {
  test(`native ${status} remains an error without legacy terminal/exit-code fields`, () => {
    for (const projected of project({ task: "inspect", agent: "scout" }, native([{ child: 1, task: "inspect", status }], true), true)) {
      assert.equal(projected[0].isError, true);
      assert.deepEqual(projected[0].details.results, [{ agent: "scout", success: false }]);
      assert.doesNotMatch(projected[0].content[0].text, /Subagent did not start/);
    }
  });
}

test("native mixed parallel results preserve child ordinals and isolate failures", () => {
  const args = { tasks: [{ task: "one", agent: "scout" }, { task: "two", agent: "reviewer" }] };
  const result = native([
    { child: 2, task: "two", status: "failed", error: "actual worker failure" },
    { child: 1, task: "one", status: "completed", task_outcome: { state: "delivered", reported: true, summary: "one completed" } },
  ], true, "Unframed aggregate must not be copied to every child");
  for (const projected of project(args, result, true)) {
    assert.deepEqual(projected.map(row => row.isError), [false, true]);
    assert.deepEqual(projected.map(row => row.details.results), [[{ agent: "scout", success: true }], [{ agent: "reviewer", success: false }]]);
    assert.match(projected[0].content[0].text, /one completed/);
    assert.match(projected[1].content[0].text, /actual worker failure/);
    assert(projected.every(row => !row.content[0].text.includes("Unframed aggregate")));
  }
});

test("missing native child still fails rather than borrowing a sibling result", () => {
  for (const projected of project({ task: "one", agent: "scout" }, native([{ child: 2, task: "other", status: "completed" }])) ) {
    assert.equal(projected[0].isError, true);
    assert.match(projected[0].content[0].text, /Subagent did not start/);
  }
});
