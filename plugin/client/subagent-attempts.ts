/** Inventory is already scoped to a verified parent session and runtime epoch. */
export function groupSubagentAttempts<T extends { taskId: string; childId: string; attempt: number; runtimeId: string | null }>(rows: T[]): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const attempts = groups.get(row.taskId) ?? [];
		attempts.push(row);
		groups.set(row.taskId, attempts);
	}
	for (const attempts of groups.values()) attempts.sort((a, b) => b.attempt - a.attempt || a.childId.localeCompare(b.childId));
	return groups;
}
export function attemptIdentity(row: { taskId: string; childId: string; attempt: number; runtimeId: string | null }): string {
	return JSON.stringify([row.taskId, row.childId, row.attempt, row.runtimeId]);
}
