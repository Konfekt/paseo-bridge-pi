import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantText, formatModelList, formatResumeList, formatSessionInfo, parsePathArgument, parseThinkingLevel,
  pickResumeTarget, resolveModelArgument, serializeBranchJsonl, sideQuestionContext, sideQuestionPrompt,
} from "../extension/paseo-commands.ts";

const models = [
  { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
  { provider: "openrouter", id: "claude-sonnet", name: "Claude Sonnet" },
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
];

test("/model resolves exact, unique and ambiguous arguments", () => {
  assert.equal(resolveModelArgument("openai/gpt-5", models), models[2]);
  assert.equal(resolveModelArgument("GPT-5", models), models[2]);
  assert.equal(resolveModelArgument("anthropic/claude-sonnet", models), models[0]);
  assert.match(resolveModelArgument("claude-sonnet", models) as string, /matches several models: anthropic\/claude-sonnet, openrouter\/claude-sonnet/);
  assert.equal(resolveModelArgument("openai/gpt", models), models[2]);
  assert.match(resolveModelArgument("missing", models) as string, /No available model matches "missing"/);
  const list = formatModelList(models, models[2]);
  assert.match(list, /^Current model: openai\/gpt-5$/m);
  assert.match(list, /^\* openai\/gpt-5$/m);
  assert.match(list, /^- anthropic\/claude-sonnet$/m);
  assert.match(formatModelList([], undefined), /none with configured credentials/);
});

test("/thinking accepts Pi's levels only", () => {
  assert.equal(parseThinkingLevel(" High "), "high");
  assert.equal(parseThinkingLevel("xhigh"), "xhigh");
  assert.equal(parseThinkingLevel("loud"), undefined);
});

test("/session text reports messages, tokens, context and cost", () => {
  const text = formatSessionInfo({
    sessionFile: "/s.jsonl", sessionId: "abc", userMessages: 2, assistantMessages: 2, toolCalls: 3, toolResults: 3, totalMessages: 7,
    tokens: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0, total: 1050 }, cost: 0.0123,
    contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
  }, { name: "Plan", model: models[2], thinking: "high" });
  for (const line of ["Name: Plan", "File: /s.jsonl", "ID: abc", "Model: openai/gpt-5 (thinking high)", "Tools: 3 calls, 3 results",
    "Input: 1,000", "  Cached: 900 (90.0%)", "Output: 50", "Context: 1,000 of 200,000 (0.5%)", "Cost: $0.012"]) {
    assert.ok(text.split("\n").includes(line), `${line} in\n${text}`);
  }
});

test("/export paths and JSONL follow Pi's own export", () => {
  assert.equal(parsePathArgument(""), undefined);
  assert.equal(parsePathArgument("out.html extra"), "out.html");
  assert.equal(parsePathArgument('"my file.jsonl" x'), "my file.jsonl");
  assert.equal(parsePathArgument('"unterminated'), undefined);
  const text = serializeBranchJsonl({ version: 3, id: "s1", cwd: "/w" }, [
    { id: "a", parentId: "root", type: "message" }, { id: "b", parentId: "x", type: "message" },
  ], "2026-01-01T00:00:00.000Z");
  assert.deepEqual(text.trim().split("\n").map(line => JSON.parse(line)), [
    { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" },
    { id: "a", parentId: null, type: "message" }, { id: "b", parentId: "a", type: "message" },
  ]);
});

test("/resume lists sessions and picks by number, exact id or unique prefix", () => {
  const sessions = [
    { path: "/a", id: "0190-aaaa", name: "Release", modified: new Date("2026-01-02T03:04:00Z"), messageCount: 4, firstMessage: "plan it" },
    { path: "/b", id: "0190-aabb", modified: new Date("2026-01-01T00:00:00Z"), messageCount: 2, firstMessage: "fix the\nbug" },
  ];
  const list = formatResumeList(sessions, "/b");
  assert.match(list, /^1\. Release - 4 messages, 2026-01-02 03:04 UTC, id 0190-aaaa$/m);
  assert.match(list, /^2\. fix the bug \(current\) - 2 messages/m);
  assert.equal(formatResumeList([], undefined), "No saved Pi sessions in this folder.");
  assert.equal(pickResumeTarget("2", sessions), sessions[1]);
  assert.match(pickResumeTarget("3", sessions) as string, /no session 3/);
  assert.equal(pickResumeTarget("0190-aabb", sessions), sessions[1]);
  assert.match(pickResumeTarget("0190-aa", sessions) as string, /matches several sessions/);
  assert.equal(pickResumeTarget("Release", sessions), sessions[0]);
  assert.match(pickResumeTarget("zzz", sessions) as string, /No session matches/);
});

test("side questions see a bounded transcript and return plain text", () => {
  const entries = [
    { type: "compaction", summary: "earlier work" },
    { type: "message", message: { role: "user", content: "first question" } },
    { type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "hidden" }, { type: "text", text: "an answer" }, { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
    ] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "file body" }] } },
    { type: "model_change" },
  ] as any;
  const context = sideQuestionContext(entries);
  assert.equal(context, 'Summary of earlier conversation: earlier work\n\nUser: first question\n\nAssistant: an answer\nTool call: read({"path":"a.ts"})');
  const bounded = sideQuestionContext([{ type: "message", message: { role: "user", content: "x".repeat(50) } }] as any, 20);
  assert.ok(bounded.startsWith("[Earlier context omitted]\n") && bounded.endsWith("x".repeat(20)));
  assert.match(sideQuestionPrompt("why?", ""), /No conversation yet\.[\s\S]*<side_question>\nwhy\?\n<\/side_question>$/);
  assert.equal(assistantText({ content: [{ type: "thinking", thinking: "t" }, { type: "text", text: " a " }, { type: "text", text: "b" }] }), "a \nb");
  assert.equal(assistantText(undefined), "");
});
