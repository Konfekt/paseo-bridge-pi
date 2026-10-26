/** Public route hints are always recomputed from one owner-scoped registry read. */
export function correlateChildRoutes<T extends { items?: any[] }>(page: T, ownerSessionId: string, records: any[], tokenForPid: (pid: number) => string | null): T {
  if (!Array.isArray(page?.items)) return page;
  if (page.items.length > 50) throw new Error("Invalid subagent page size");
  const tokens = new Map<number, string | null>();
  const token = (pid: number) => { if (!tokens.has(pid)) tokens.set(pid, tokenForPid(pid)); return tokens.get(pid)!; };
  return { ...page, items: page.items.map(item => {
    const { paseoAgentId: _agent, paseoWorkspaceId: _workspace, ...row } = item;
    const route = resolveExactChildRuntime(ownerSessionId, row, records, token);
    return route.available ? { ...row, paseoAgentId: route.agentId, paseoWorkspaceId: route.workspaceId } : row;
  }) };
}

export type ChildTitleRow = { title: string; paseoAgentId?: string; paseoWorkspaceId?: string };
export function nativeChildTitle(row: ChildTitleRow, lookup: (id: string) => { workspaceId: string; title?: string | null } | undefined): string {
  const agent = row.paseoAgentId && row.paseoWorkspaceId ? lookup(row.paseoAgentId) : undefined;
  if (agent && agent.workspaceId === row.paseoWorkspaceId && typeof agent.title === "string" && agent.title.trim()) return agent.title;
  // Producer already prefers the configured worker name/profile. Do not expand
  // a missing-title fallback into the full task instructions.
  return row.title?.slice(0, 140) || "Worker";
}

export type ExactChildIdentity = { taskId: string; childId: string; groupId: string; runtimeId: string; attempt: number };
export type PaseoRuntimeLink = { available: boolean; agentId: string | null; workspaceId: string | null; reason: string | null };
const unavailable = (reason: string): PaseoRuntimeLink => ({ available: false, agentId: null, workspaceId: null, reason });

/** Resolve only an exact, current, process-identity-verified child runtime. */
export function resolveExactChildRuntime(ownerSessionId: string, identity: ExactChildIdentity,
  records: any[], tokenForPid: (pid: number) => string | null): PaseoRuntimeLink {
  if (!ownerSessionId || !identity || typeof identity.taskId !== "string" || typeof identity.childId !== "string"
    || typeof identity.groupId !== "string" || typeof identity.runtimeId !== "string"
    || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1) return unavailable("Incomplete exact child identity.");
  const exact = records.filter((record: any) => record.lifecycle === "active" && record.managed === true
    && record.parentSessionId === ownerSessionId && record.taskId === identity.taskId && record.childId === identity.childId
    && record.groupId === identity.groupId && record.runtimeId === identity.runtimeId && Number(record.attempt) === identity.attempt);
  const live = exact.filter((record: any) => Number.isSafeInteger(record.pid) && record.pid > 0
    && typeof record.processStartToken === "string" && tokenForPid(record.pid) === record.processStartToken
    && typeof record.agentId === "string" && record.agentId && typeof record.workspaceId === "string" && record.workspaceId);
  if (live.length !== 1) return unavailable(live.length > 1 ? "Child runtime identity is ambiguous." : "No matching live Paseo child runtime.");
  return { available: true, agentId: live[0].agentId, workspaceId: live[0].workspaceId, reason: null };
}
