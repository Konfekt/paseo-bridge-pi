import { createHash } from "node:crypto";

export function paseoImportArgs(input: {
  sessionFile: string; cwd: string; host?: string;
}): string[] {
  return ["import", "--provider", "pi", input.sessionFile, "--cwd", input.cwd, "--json",
    ...(input.host ? ["--host", input.host] : [])];
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
