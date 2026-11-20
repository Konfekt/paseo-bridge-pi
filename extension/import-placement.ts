import { createHash } from "node:crypto";
import * as fs from "node:fs";

export function paseoImportArgs(input: {
  sessionFile: string; cwd: string; host?: string;
}): string[] {
  return ["import", "--provider", "pi", input.sessionFile, "--cwd", input.cwd, "--json",
    ...(input.host ? ["--host", input.host] : [])];
}

/** Whether Pi has written the session file that Paseo reads on import. */
export function sessionFileSaved(sessionFile: string): boolean {
  try {
    return fs.statSync(sessionFile).isFile();
  } catch {
    return false;
  }
}

export function importRetryDelay(failures: number): number | undefined {
  return failures >= 1 && failures <= 5 ? Math.min(2000 * 2 ** (failures - 1), 30000) : undefined;
}

/** Stable per-session workspace ID in Paseo's `wks_<16 hex>` format, so retries
 * and later TUI starts address the same workspace instead of creating another. */
export function sessionWorkspaceId(sessionKey: string): string {
  const digest = createHash("sha256").update(`paseo-bridge-pi\0${sessionKey}`).digest("hex");
  return `wks_${digest.slice(0, 16)}`;
}

const MAX_TITLE_LENGTH = 80;

export function sessionWorkspaceTitle(...candidates: Array<string | null | undefined>): string | undefined {
  for (const candidate of candidates) {
    const text = (candidate ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text;
  }
  return undefined;
}

/** Text of the first user message in pi session entries, if any. */
export function firstUserPrompt(entries: readonly any[]): string | undefined {
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((part: any) => part?.type === "text" && typeof part.text === "string")
          .map((part: any) => part.text).join(" ")
        : "";
    if (text.trim()) return text;
  }
  return undefined;
}

export interface PaseoRequester {
  request(build: (requestId: string) => Record<string, unknown>): Promise<any>;
}

export async function fetchPaseoAgent(conn: PaseoRequester, agentId: string): Promise<any | null> {
  const payload = await conn.request(requestId => ({ type: "fetch_agent_request", agentId, requestId }));
  if (payload?.error) throw new Error(String(payload.error));
  return payload?.agent ?? null;
}

export async function reloadPaseoAgent(conn: PaseoRequester, agentId: string): Promise<void> {
  const payload = await conn.request(requestId => ({ type: "refresh_agent_request", agentId, requestId }));
  if (payload?.status !== "agent_refreshed" || payload?.agentId !== agentId) {
    throw new Error(typeof payload?.error === "string" ? payload.error : "Paseo agent reload failed");
  }
}

/** Reuse a saved agent without interrupting a controller that is already attached. */
export async function reusePaseoAgent(conn: PaseoRequester, agentId: string, needsReload: () => boolean): Promise<boolean> {
  const agent = await fetchPaseoAgent(conn, agentId);
  if (!agent || agent.archivedAt) return false;
  // Check after admission/lookup: the controller may have connected while they waited.
  if (needsReload()) await reloadPaseoAgent(conn, agentId);
  return true;
}

/** Recover a lost local agent-map entry using Paseo's persisted native handle. */
export async function findImportedPiAgent(conn: PaseoRequester, sessionFile: string): Promise<string | undefined> {
  let cursor: string | undefined;
  let count = 0;
  const seen = new Set<string>();
  for (let page = 0; page < 200; page += 1) {
    const payload = await conn.request(requestId => ({
      type: "fetch_agents_request", requestId, filter: { includeArchived: false },
      sort: [{ key: "created_at", direction: "asc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    }));
    if (payload?.error) throw new Error(String(payload.error));
    if (!Array.isArray(payload?.entries)) throw new Error("Paseo agent directory response is invalid");
    count += payload.entries.length;
    if (count > 10_000) throw new Error("Paseo agent directory exceeds the bridge's 10000-entry limit");
    for (const { agent } of payload.entries) {
      const handle = agent?.persistence?.nativeHandle ?? agent?.persistence?.sessionId;
      if (agent?.provider === "pi" && !agent.archivedAt && handle === sessionFile && typeof agent.id === "string") return agent.id;
    }
    if (!payload.pageInfo?.hasMore) return undefined;
    const next = payload.pageInfo.nextCursor;
    if (typeof next !== "string" || !next || seen.has(next)) throw new Error("Paseo agent directory pagination did not advance");
    seen.add(next);
    cursor = next;
  }
  throw new Error("Paseo agent directory exceeds the bridge's 200-page limit");
}

export interface SessionImport {
  agentId: string;
  /** The session's own workspace, or undefined when it joined the folder workspace. */
  workspaceId: string | undefined;
  /** True when the session's workspace exists without a title. */
  untitled: boolean;
}

/** Paseo answers a repeated create of the same workspace ID with this code. */
const WORKSPACE_EXISTS = "workspace_id_conflict";

async function importAgent(conn: PaseoRequester, input: {
  sessionFile: string; cwd: string; workspaceId?: string;
}): Promise<string> {
  const payload = await conn.request((requestId) => ({
    type: "import_agent_request",
    requestId,
    provider: "pi",
    sessionId: input.sessionFile,
    cwd: input.cwd,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  }));
  const agentId = payload?.agent?.id;
  if (payload?.status === "agent_resumed" && typeof agentId === "string" && agentId) return agentId;
  throw new Error(typeof payload?.error === "string" ? payload.error : "Paseo import failed");
}

/**
 * Paseo lists workspaces, not agents, so importing every pi session into its
 * folder's shared workspace shows a single entry per folder. Each session gets
 * its own workspace in the same directory. Hosts that cannot provide it still
 * receive the session in the folder workspace.
 */
export async function importIntoSessionWorkspace(
  conn: PaseoRequester,
  input: { sessionFile: string; cwd: string; workspaceId: string; title?: string },
  onPlacementFallback: (error: unknown) => void = () => {},
): Promise<SessionImport> {
  const { sessionFile, cwd, workspaceId, title } = input;
  let created = false;
  let placed = false;
  try {
    const payload = await conn.request((requestId) => ({
      type: "workspace.create.request",
      requestId,
      workspaceId,
      source: { kind: "directory", path: cwd },
      ...(title ? { title } : {}),
    }));
    const error = payload?.error;
    if (error && error !== WORKSPACE_EXISTS && payload?.errorCode !== WORKSPACE_EXISTS)
      throw new Error(String(error));
    created = !error;
    placed = true;
  } catch (error) {
    onPlacementFallback(error);
  }
  if (placed) {
    try {
      const agentId = await importAgent(conn, { sessionFile, cwd, workspaceId });
      return { agentId, workspaceId, untitled: created && !title };
    } catch (error) {
      // An archived session workspace keeps its ID; the session then joins the folder.
      if (!String((error as Error)?.message ?? error).includes(`Workspace not found: ${workspaceId}`)) throw error;
      onPlacementFallback(error);
    }
  }
  return { agentId: await importAgent(conn, { sessionFile, cwd }), workspaceId: undefined, untitled: false };
}

export function workspaceTitleRequest(workspaceId: string, title: string) {
  return (requestId: string) => ({ type: "workspace.title.set.request", workspaceId, title, requestId });
}
