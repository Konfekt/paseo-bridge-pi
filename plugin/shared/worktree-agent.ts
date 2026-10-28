/** Recorded ownership is not a claim that a worker is running or a list of all assignments. */
export type RecordedWorktreeOwner = {
	ownerSessionId: string;
	taskId: string;
	childId: string;
	canonicalDisplayName?: string;
};
export type WorktreeAgentSource = {
	agentId: string;
	workspaceId: string;
	sessionId: string;
	runtimeEpoch: string;
};
export type WorktreeAgentEvidence = {
	taskId: string;
	childId: string;
	groupId: string;
	runtimeId: string | null;
	attempt: number;
	stale: boolean;
	reaped?: boolean;
	paseoAgentId?: string;
	paseoWorkspaceId?: string;
	source?: WorktreeAgentSource;
};
export type WorktreeAgentRoute = WorktreeAgentSource & {
	taskId: string;
	childId: string;
	groupId: string;
	runtimeId: string;
	attempt: number;
};

/** Never substitute ownerTitle, a task description, cwd or a directory basename. */
export function recordedAgentName(owner: RecordedWorktreeOwner): string | null {
	const value = owner.canonicalDisplayName;
	// Mirrors subagent/tui-names.ts:validateSubagentDisplayName at the producer
	// boundary. Do not apply a new stricter naming policy or derive from task text.
	if (typeof value !== "string" || value.length > 80 || value !== value.trim() || !value
		|| /[\p{Cc}\p{Cf}]/u.test(value) || value.split(/\s+/u).length > 4) return null;
	return value.replace(/\s+/gu, " ");
}

/** Native title fallback requires the exact server-correlated agent/workspace pair. */
export function recordedAgentDisplayName(
	owner: RecordedWorktreeOwner,
	verifiedLink: { agentId: string; workspaceId: string } | null,
	native: { id: string; workspaceId: string; title: string | null } | null,
): string | null {
	const recorded = recordedAgentName(owner);
	if (recorded) return recorded;
	if (!verifiedLink || !native || native.id !== verifiedLink.agentId || native.workspaceId !== verifiedLink.workspaceId) return null;
	return recordedAgentName({ ...owner, canonicalDisplayName: native.title ?? undefined });
}

/**
 * Correlate only within an already verified harness inventory/ancestry boundary.
 * This is a route REQUEST, not authority to navigate: existing harness_subagent_route
 * must recheck the full runtime identity before its returned agentId is opened.
 * Partial inventory cannot disambiguate ownership and therefore fails closed.
 */
export function recordedAgentRoute(
	owner: RecordedWorktreeOwner,
	root: WorktreeAgentSource,
	items: readonly WorktreeAgentEvidence[],
	complete: boolean,
): WorktreeAgentRoute | null {
	if (!complete || !owner.ownerSessionId || !/^subagent-task-[a-f0-9]{24}$/.test(owner.taskId)
		|| !/^subagent-child-[a-f0-9]{24}$/.test(owner.childId)) return null;
	const matches = items.filter(item => item.taskId === owner.taskId && item.childId === owner.childId
		&& (item.source ?? root).sessionId === owner.ownerSessionId);
	if (matches.length !== 1) return null;
	const item = matches[0], source = item.source ?? root;
	if (item.stale || item.reaped || !item.paseoAgentId || !item.paseoWorkspaceId || !item.runtimeId || !/^subagent-job-[a-f0-9]{24}$/.test(item.groupId)
		|| !Number.isSafeInteger(item.attempt) || item.attempt < 1
		|| !source.agentId || !source.workspaceId || !source.runtimeEpoch) return null;
	return { ...source, taskId: item.taskId, childId: item.childId, groupId: item.groupId, runtimeId: item.runtimeId, attempt: item.attempt };
}
