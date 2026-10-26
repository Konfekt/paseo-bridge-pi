import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolResult, toolDetailSections, mergeLiveToolEvents, TOOL_DETAIL_BYTES } from "../client/native-tool-details.ts";

test("live end events preserve only their correlated start arguments", () => {
  const events = mergeLiveToolEvents([
    { toolCallId: "read-1", arguments: { path: "a" }, result: undefined },
    { toolCallId: "write-1", arguments: { path: "b", content: "body" }, result: undefined },
    { toolCallId: "read-1", arguments: undefined, result: "read output" },
  ]);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].arguments, { path: "a" });
  assert.equal(events[0].result, "read output");
  assert.deepEqual(events[1].arguments, { path: "b", content: "body" });
});

test("actual retained Read envelope renders text once without JSON escaping", () => {
  const text = 'export const value = "hello";\nnext line\n';
  const raw = JSON.stringify({ content: [{ type: "text", text }], structuredContent: text });
  assert.equal(normalizeToolResult(raw), text);
  assert.deepEqual(toolDetailSections("read", { path: "/src/a.ts", offset: 1, limit: 20 }, raw), [
    { label: "File", text: "/src/a.ts" }, { label: "Content", text },
  ]);
});
test("double-stringified actual MCP Read wire result is decoded, but terminal text is not", () => {
  const file = 'export const literal = "hello";\n';
  const result = JSON.stringify(JSON.stringify({ content: [{ type: "text", text: file }], structuredContent: file }));
  assert.deepEqual(toolDetailSections("read", { path: "/tmp/example.ts", offset: 1, limit: 20 }, result), [
    { label: "File", text: "/tmp/example.ts" }, { label: "Content", text: file },
  ]);
  for (const literal of ['{"content":[1,2]}', '{"content":[{"text":"file data"}]}', '{"content":[]}', '{"content":[{"type":"text","text":"file data"}],"title":"JSON document"}']) {
    assert.equal(normalizeToolResult(literal), literal);
    assert.equal(normalizeToolResult(JSON.stringify(literal)), JSON.stringify(literal), "non-envelope wire-looking strings retain exact quoting");
    assert.equal(normalizeToolResult(JSON.stringify({ content: [{ type: "text", text: literal }], structuredContent: literal })), literal);
  }
});

test("literal JSON text blocks are terminal, including envelope-shaped file contents", () => {
  const literal = '{"content":[{"type":"text","text":"do not unwrap me"}]}';
  assert.equal(normalizeToolResult(JSON.stringify({ content: [{ type: "text", text: literal }], structuredContent: "duplicate" })), literal);
  assert.equal(normalizeToolResult('{"name":"read","path":"literal.json"}'), '{"name":"read","path":"literal.json"}');
});
test("native string, nested MCP result, structured fallback, errors, images", () => {
  assert.equal(normalizeToolResult("line one\nline two"), "line one\nline two");
  assert.equal(normalizeToolResult({ type: "tool_result", content: JSON.stringify({ content: [{ type: "text", text: "nested" }] }) }), "nested");
  assert.equal(normalizeToolResult({ content: [], structuredContent: "fallback" }), "fallback");
  assert.equal(normalizeToolResult({ isError: true, content: [{ type: "text", text: "denied" }, { type: "image", mimeType: "image/png", data: "secret base64" }] }), "[tool error]\ndenied\n[image: image/png]");
});
test("all tools normalize transport, including shell JSON stdout and unknown MCP tools", () => {
  const stdout = '{"content":[{"type":"text","text":"this is command output, not another transport"}],"count":2}';
  const result = JSON.stringify({ content: [{ type: "text", text: stdout }, { type: "text", text: "stderr: warning" }], details: {}, structuredContent: { output: stdout, exit_code: 0 } });
  for (const name of ["bash", "shell", "custom_unknown_tool"]) {
    const sections = toolDetailSections(name, { command: "printf JSON" }, result);
    assert.equal(sections.at(-1)?.text, `${stdout}\nstderr: warning`);
    assert.equal(sections.filter(section => section.text.includes(stdout)).length, 1);
  }
  assert.equal(normalizeToolResult({ content: [], structuredContent: { content: [1, 2], business: { retained: true } } }), JSON.stringify({ content: [1, 2], business: { retained: true } }, null, 2));
  assert.equal(normalizeToolResult({ type: "tool_result", content: JSON.stringify({ content: [{ type: "text", text: stdout }] }) }), stdout);
});

test("mixed MCP audio/error/text and future blocks never expose binary payloads", () => {
  const result = { isError: true, content: [
    { type: "audio", mimeType: "audio/wav", data: "AUDIO_BASE64_SECRET" },
    { type: "text", text: "Audio decoding failed; useful error" },
    { type: "image", mimeType: "image/png", data: "IMAGE_BASE64_SECRET" },
    { type: "future_binary", mimeType: "application/octet-stream", data: "FUTURE_BASE64_SECRET" },
    { type: "future_metadata", token: "UNSUPPORTED_SECRET" },
  ] };
  const output = normalizeToolResult(JSON.stringify(result));
  assert.equal(output, ["[tool error]", "[audio: audio/wav]", "Audio decoding failed; useful error", "[image: image/png]", "[unsupported content: future_binary]", "[unsupported content: future_metadata]"].join("\n"));
  assert.doesNotMatch(output, /BASE64|UNSUPPORTED_SECRET/);
  assert.equal(normalizeToolResult({ content: [{ type: "future_binary", mimeType: "application/octet-stream", data: "x".repeat(100000) }] }), "[unsupported content: future_binary]");
  assert.equal(normalizeToolResult(JSON.stringify({ content: [{ type: "audio", mimeType: "audio/wav", data: "AUDIO_BASE64_SECRET".repeat(10000) }] })), "[structured tool output truncated]");
});

test("adversarial transport matrix isolates malformed siblings without exposing payloads", () => {
  const malformed = [null, 42, false, "PRIMITIVE_SECRET", [], {}, { data: "UNTYPED_SECRET" }, { type: "text", text: 99 }, { type: "future", payload: "UNKNOWN_SECRET" }];
  const media = [
    { type: "image", mimeType: "image/png", data: "IMAGE_SECRET" },
    { type: "audio", mimeType: "audio/wav", data: "AUDIO_SECRET" },
  ];
  const encodings = [
    (value: unknown) => value,
    (value: unknown) => JSON.stringify(value),
    (value: unknown) => JSON.stringify(JSON.stringify(value)),
    (value: unknown) => ({ type: "tool_result", content: value }),
    (value: unknown) => ({ content: [{ type: "tool_result", content: value }] }),
    (value: unknown) => JSON.stringify(JSON.stringify({ type: "tool_result", content: value })),
  ];
  let count = 0;
  for (const bad of malformed) for (const binary of media) for (const encode of encodings) {
    const output = normalizeToolResult(encode({ content: [bad, binary, { type: "text", text: "useful text" }], isError: true }));
    assert.match(output, /\[unsupported content/);
    assert.match(output, /useful text/);
    assert.match(output, /\[tool error\]/);
    assert.ok(output.includes(binary.type === "image" ? "[image: image/png]" : "[audio: audio/wav]"));
    assert.doesNotMatch(output, /SECRET|"content"|"data"/);
    assert.ok(Buffer.byteLength(output) <= TOOL_DETAIL_BYTES);
    count++;
  }
  for (const marker of [{ type: "tool_result" }, { type: "toolResult" }, { isError: true }, { structuredContent: "fallback" }]) {
    for (const invalidBlocks of [malformed, [null, null], [42, false, "PRIMITIVE_SECRET"], [{ data: "UNTYPED_SECRET" }]]) for (const encode of encodings) {
      const output = normalizeToolResult(encode({ ...marker, content: invalidBlocks }));
      assert.doesNotMatch(output, /SECRET|"content"|"data"/);
      assert.equal(output.split("[unsupported content").length - 1, invalidBlocks.length);
      count++;
    }
  }
  assert.equal(count, 204, "all malformed/media/transport combinations exercised");
});

test("ordinary JSON content arrays and terminal file JSON are never treated as malformed transport", () => {
  const files = [
    { content: [null, 1, "literal", {}, { data: "literal data" }] },
    { content: [{ type: "future", payload: "literal data" }] },
    { content: [1, 2], title: "business document" },
    { content: [] },
    { content: [{ type: "image", mimeType: "image/png", data: "LITERAL_FILE_DATA" }], title: "not MCP" },
  ];
  for (const file of files) {
    const literal = JSON.stringify(file);
    assert.equal(normalizeToolResult(literal), literal);
    assert.equal(normalizeToolResult(JSON.stringify(literal)), JSON.stringify(literal));
    assert.equal(normalizeToolResult({ content: [{ type: "text", text: literal }] }), literal);
  }
  const actualEnvelopeShapedFile = JSON.stringify({ content: [{ type: "image", mimeType: "image/png", data: "LITERAL_FILE_DATA" }] });
  assert.equal(normalizeToolResult({ content: [{ type: "text", text: actualEnvelopeShapedFile }] }), actualEnvelopeShapedFile);
});

test("Write and Edit use authoritative exact args, not result identity/context", () => {
  assert.deepEqual(toolDetailSections("write", { path: "a", content: "a\nb" }, "ok"), [
    { label: "File", text: "a" }, { label: "Content", text: "a\nb" }, { label: "Result", text: "ok" },
  ]);
  assert.deepEqual(toolDetailSections("edit", { path: "a", edits: [{ oldText: "before", newText: "after" }] }, undefined), [
    { label: "File", text: "a" }, { label: "Removed", text: "before", tone: "removed" }, { label: "Added", text: "after", tone: "added" },
  ]);
  assert.equal(toolDetailSections("unknown", { name: "read", path: "a" }, "raw")[0].label, "Arguments");
  assert.equal(toolDetailSections("functions.read", { path: "a" }, "raw")[0].label, "Arguments");
  assert.equal(toolDetailSections("edit", { path: "a", truncated: true, preview: "not exact" }, undefined).some(section => section.tone), false);
});
test("malformed/truncated transport remains readable; depth, bytes, and block count bounded", () => {
  assert.equal(normalizeToolResult('{"content":[{"type":"text","text":"cut'), '{"content":[{"type":"text","text":"cut');
  const boundedEmoji = normalizeToolResult("😀".repeat(TOOL_DETAIL_BYTES));
  assert.match(boundedEmoji, /\[truncated\]$/);
  assert.ok(Buffer.byteLength(boundedEmoji) <= TOOL_DETAIL_BYTES);
  let nested: unknown = { content: [{ type: "text", text: "deep" }] };
  for (let i = 0; i < 12; i++) nested = { type: "tool_result", content: nested };
  assert.match(normalizeToolResult(nested), /nesting limit/);
  assert.match(normalizeToolResult({ content: Array.from({ length: 200 }, () => ({ type: "text", text: "line" })) }), /\[truncated\]$/);
});
