import { taskGroupKey, type TaskSource } from "../shared/subagent-tree.ts";
/** Inventory is already scoped to a verified parent session and runtime epoch. */
export function groupSubagentAttempts<T extends { taskId: string; childId: string; attempt: number; runtimeId: string | null; source?: TaskSource }>(rows: T[]): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const attempts = groups.get(taskGroupKey(row)) ?? [];
		attempts.push(row);
		groups.set(taskGroupKey(row), attempts);
	}
	for (const attempts of groups.values()) attempts.sort((a, b) => b.attempt - a.attempt || a.childId.localeCompare(b.childId));
	return groups;
}
export function attemptIdentity(row: { taskId: string; childId: string; attempt: number; runtimeId: string | null; source?: TaskSource }): string {
	return JSON.stringify([taskGroupKey(row), row.childId, row.attempt, row.runtimeId]);
}
