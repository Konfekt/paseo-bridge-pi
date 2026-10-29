import { recordedAgentRoute, type WorktreeAgentEvidence, type WorktreeAgentSource } from "./worktree-agent";

/** Display evidence is independent of whether a current chat can be opened. */
export function goalAgentEvidence<T extends WorktreeAgentEvidence>(child: { taskId: string; childId: string; jobId: string; attempt: number }, root: WorktreeAgentSource, items: readonly T[], complete: boolean): T | null {
  if (!complete) return null;
  const matches = items.filter(item => item.taskId === child.taskId && item.childId === child.childId
    && item.groupId === child.jobId && item.attempt === child.attempt && (item.source ?? root).sessionId === root.sessionId);
  return matches.length === 1 && !matches[0].stale ? matches[0] : null;
}

/** Dedicated assignment only. Neither shared cwd nor taskId alone proves membership. */
export function goalAgentRoute(child: { taskId: string; childId: string; jobId: string; attempt: number }, root: WorktreeAgentSource, items: readonly WorktreeAgentEvidence[], complete: boolean) {
  const route = recordedAgentRoute({ ownerSessionId: root.sessionId, taskId: child.taskId, childId: child.childId }, root, items, complete);
  return route?.groupId === child.jobId && route.attempt === child.attempt ? route : null;
}
