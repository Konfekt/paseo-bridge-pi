import { recordedAgentRoute, type WorktreeAgentEvidence, type WorktreeAgentSource } from "./worktree-agent";

/** Dedicated assignment only. Neither shared cwd nor taskId alone proves membership. */
export function goalAgentRoute(child: { taskId: string; childId: string; jobId: string; attempt: number }, root: WorktreeAgentSource, items: readonly WorktreeAgentEvidence[], complete: boolean) {
  const route = recordedAgentRoute({ ownerSessionId: root.sessionId, taskId: child.taskId, childId: child.childId }, root, items, complete);
  return route?.groupId === child.jobId && route.attempt === child.attempt ? route : null;
}
