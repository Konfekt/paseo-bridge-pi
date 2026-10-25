import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { importRetryDelay, paseoImportArgs, retryableWorkspaceImportFailure, workspaceIdForPlacement } from "../extension/import-placement.ts";

const placement = { tmuxSocket: "/run/user/1000/tmux.sock", tmuxServerId: "12:345:678", tmuxWindowId: "@9" };
test("topology import passes the server deterministic workspace from actual placement", () => {
  const expected = "wks_tmux_" + createHash("sha256").update(JSON.stringify([placement.tmuxSocket, placement.tmuxServerId, placement.tmuxWindowId])).digest("hex").slice(0, 24);
  assert.equal(workspaceIdForPlacement(placement), expected);
  assert.deepEqual(paseoImportArgs({ sessionFile: "/session.jsonl", cwd: "/repo", host: "host", topology: true, placement }),
    ["import", "--provider", "pi", "/session.jsonl", "--cwd", "/repo", "--json", "--workspace-id", expected, "--host", "host"]);
  assert.notEqual(workspaceIdForPlacement({ ...placement, tmuxWindowId: "@10" }), expected);
  assert.notEqual(workspaceIdForPlacement({ ...placement, tmuxServerId: "12:999:678" }), expected);
});
test("non-topology imports preserve legacy arguments; missing live topology fails closed", () => {
  assert.deepEqual(paseoImportArgs({ sessionFile: "/s", cwd: "/c", topology: false, placement: {} }), ["import", "--provider", "pi", "/s", "--cwd", "/c", "--json"]);
  assert.throws(() => paseoImportArgs({ sessionFile: "/s", cwd: "/c", topology: true, placement: {} }), /Current tmux workspace identity is unavailable/);
});
test("workspace projection rejection retries are bounded; ambiguous outcomes do not retry", () => {
  // Current workspace-provisioning service rejects these before allocating
  // an import; topology validation adds the explicit-projection rejection.
  const rejected = [
    "Workspace not found: wks_tmux_0123456789abcdef01234567",
    "Project not found: prj_tmux_0123456789abcdef01234567",
    "Import requires an explicit projected tmux workspaceId",
  ];
  for (const message of rejected) {
    assert.equal(retryableWorkspaceImportFailure(1, message), true, message);
    assert.equal(retryableWorkspaceImportFailure(0, message), false, `successful response: ${message}`);
    assert.equal(retryableWorkspaceImportFailure(null, message), false, `unknown completion: ${message}`);
  }
  for (const message of [
    "Workspace wks_tmux_abc not found", "Unknown requested workspace",
    "Workspace not found: arbitrary-workspace", "Project not found: arbitrary-project",
    "Import cwd does not match workspace: wks_tmux_0123456789abcdef01234567",
    "workspace malformed response", "workspace timed out", "network connection lost",
  ]) assert.equal(retryableWorkspaceImportFailure(1, message), false, message);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(importRetryDelay), [2000, 4000, 8000, 16000, 30000, undefined]);
});
