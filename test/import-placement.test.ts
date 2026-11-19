import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  firstUserPrompt,
  importIntoSessionWorkspace,
  importRetryDelay,
  paseoImportArgs,
  sessionFileSaved,
  sessionWorkspaceId,
  sessionWorkspaceTitle,
  workspaceTitleRequest,
} from "../extension/import-placement.ts";

test("import command names the native session and its working directory", () => {
  assert.deepEqual(paseoImportArgs({ sessionFile: "/session.jsonl", cwd: "/repo", host: "host" }),
    ["import", "--provider", "pi", "/session.jsonl", "--cwd", "/repo", "--json", "--host", "host"]);
  assert.deepEqual(paseoImportArgs({ sessionFile: "/s", cwd: "/c" }),
    ["import", "--provider", "pi", "/s", "--cwd", "/c", "--json"]);
});

test("import waits until Pi has saved the session file", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-saved-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.jsonl");
  assert.equal(sessionFileSaved(sessionFile), false, "a new session has no file yet");
  mkdirSync(path.join(directory, "folder.jsonl"));
  assert.equal(sessionFileSaved(path.join(directory, "folder.jsonl")), false);
  writeFileSync(sessionFile, "{\"type\":\"session\"}\n");
  assert.equal(sessionFileSaved(sessionFile), true);
});

test("automatic import retry delays are bounded", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(importRetryDelay), [2000, 4000, 8000, 16000, 30000, undefined]);
});


function fakePaseo(options: { createError?: string; createThrows?: boolean; archived?: boolean } = {}) {
  const workspaces = new Set<string>();
  const sent: any[] = [];
  let next = 0;
  const conn = {
    async request(build: (requestId: string) => Record<string, unknown>) {
      const message: any = build(`r${next++}`);
      sent.push(message);
      if (message.type === "workspace.create.request") {
        if (options.createThrows) throw new Error("Paseo request timeout");
        if (options.createError) return { requestId: message.requestId, workspace: null, error: options.createError };
        if (workspaces.has(message.workspaceId)) return { requestId: message.requestId, workspace: null, error: "workspace_id_conflict" };
        workspaces.add(message.workspaceId);
        return { requestId: message.requestId, workspace: { id: message.workspaceId }, error: null };
      }
      assert.equal(message.type, "import_agent_request");
      if (message.workspaceId && (options.archived || !workspaces.has(message.workspaceId)))
        return { status: "agent_create_failed", requestId: message.requestId, error: `Workspace not found: ${message.workspaceId}` };
      return { status: "agent_resumed", requestId: message.requestId, agent: { id: `agent-${sent.length}` } };
    },
  };
  return { conn, sent, workspaces };
}

const placement = { sessionFile: "/s/a.jsonl", cwd: "/repo", workspaceId: sessionWorkspaceId("/s/a.jsonl") };

test("each pi session gets its own stable workspace rather than one per folder", () => {
  assert.match(placement.workspaceId, /^wks_[a-f0-9]{16}$/);
  assert.equal(sessionWorkspaceId("/s/a.jsonl"), placement.workspaceId);
  assert.notEqual(sessionWorkspaceId("/s/b.jsonl"), placement.workspaceId);
});

test("import creates the session workspace, then imports into it", async () => {
  const { conn, sent } = fakePaseo();
  const result = await importIntoSessionWorkspace(conn, { ...placement, title: "Fix parser" });
  assert.deepEqual(result, { agentId: "agent-2", workspaceId: placement.workspaceId, untitled: false });
  assert.deepEqual(sent.map(({ requestId, ...rest }) => rest), [
    { type: "workspace.create.request", workspaceId: placement.workspaceId, source: { kind: "directory", path: "/repo" }, title: "Fix parser" },
    { type: "import_agent_request", provider: "pi", sessionId: "/s/a.jsonl", cwd: "/repo", workspaceId: placement.workspaceId },
  ]);
  // A retry reuses the workspace created by an earlier attempt.
  const again = await importIntoSessionWorkspace(conn, placement);
  assert.equal(again.workspaceId, placement.workspaceId);
  assert.equal(again.untitled, false);
});

test("an untitled new workspace is reported so the first prompt can name it", async () => {
  const { conn } = fakePaseo();
  assert.equal((await importIntoSessionWorkspace(conn, placement)).untitled, true);
});

test("hosts that cannot create the workspace still import into the folder workspace", async () => {
  for (const options of [{ createError: "unsupported" }, { createThrows: true }, { archived: true }]) {
    const fallbacks: unknown[] = [];
    const { conn, sent } = fakePaseo(options);
    const result = await importIntoSessionWorkspace(conn, placement, (error) => fallbacks.push(error));
    assert.equal(result.workspaceId, undefined);
    assert.equal(fallbacks.length, 1);
    assert.equal(sent.at(-1).workspaceId, undefined);
  }
});

test("other import failures propagate for the retry schedule", async () => {
  const conn = {
    async request(build: (requestId: string) => Record<string, unknown>) {
      const message: any = build("r");
      return message.type === "workspace.create.request"
        ? { error: null }
        : { status: "agent_create_failed", error: "Provider session is already imported" };
    },
  };
  await assert.rejects(importIntoSessionWorkspace(conn, placement), /already imported/);
});

test("workspace titles come from the session name or first prompt", () => {
  assert.equal(sessionWorkspaceTitle(undefined, "  fix \n the parser "), "fix the parser");
  assert.equal(sessionWorkspaceTitle("Named", "prompt"), "Named");
  assert.equal(sessionWorkspaceTitle(null, ""), undefined);
  assert.equal(sessionWorkspaceTitle("x".repeat(200))?.length, 80);
  assert.equal(firstUserPrompt([
    { type: "message", message: { role: "assistant", content: "no" } },
    { type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "hello" }] } },
  ]), "hello");
  assert.equal(firstUserPrompt([{ type: "message", message: { role: "user", content: "plain" } }]), "plain");
  assert.equal(firstUserPrompt([]), undefined);
  assert.deepEqual(workspaceTitleRequest("wks_1", "t")("r"), { type: "workspace.title.set.request", workspaceId: "wks_1", title: "t", requestId: "r" });
});
