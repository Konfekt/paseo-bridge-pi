import test from "node:test";
import assert from "node:assert/strict";
import { nativeCodeRows } from "../client/native-code-model.ts";

test("Read gutters honor actual offset and newline termination, never number truncation", () => {
  assert.deepEqual(nativeCodeRows("first\nlast\n", { startLine: 17 }), [{ text: "first", number: 17 }, { text: "last", number: 18 }]);
  assert.deepEqual(nativeCodeRows("[truncated]", { startLine: 17 }), [{ text: "[truncated]" }]);
  assert.deepEqual(nativeCodeRows("line", { startLine: -1 }), [{ text: "line" }]);
});
test("Edit fragments have diff tones but no invented positions or surrounding file context", () => {
  assert.deepEqual(nativeCodeRows("old\nfragment", { tone: "removed" }), [{ text: "old", tone: "removed" }, { text: "fragment", tone: "removed" }]);
  const actualDiff = "@@ -17,2 +17,2 @@\n retained context\n-old\n+new";
  assert.deepEqual(nativeCodeRows(actualDiff, { unifiedDiff: true }), [
    { text: "@@ -17,2 +17,2 @@", tone: "context" }, { text: " retained context", tone: "context" },
    { text: "-old", tone: "removed" }, { text: "+new", tone: "added" },
  ]);
});
test("code surface row count is bounded independently of message history budget", () => {
  const rows = nativeCodeRows("x\n".repeat(10000), { startLine: 1 });
  assert.equal(rows.length, 501);
  assert.deepEqual(rows.at(-1), { text: "[truncated]" });
});
