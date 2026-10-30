import assert from "node:assert/strict";
import test from "node:test";
import { importRetryDelay, paseoImportArgs } from "../extension/import-placement.ts";

test("import command names the native session and its working directory", () => {
  assert.deepEqual(paseoImportArgs({ sessionFile: "/session.jsonl", cwd: "/repo", host: "host" }),
    ["import", "--provider", "pi", "/session.jsonl", "--cwd", "/repo", "--json", "--host", "host"]);
  assert.deepEqual(paseoImportArgs({ sessionFile: "/s", cwd: "/c" }),
    ["import", "--provider", "pi", "/s", "--cwd", "/c", "--json"]);
});

test("automatic import retry delays are bounded", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(importRetryDelay), [2000, 4000, 8000, 16000, 30000, undefined]);
});
