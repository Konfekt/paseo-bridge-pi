export type TaskSource = { agentId: string; workspaceId: string; sessionId: string; runtimeEpoch: string };
type Task = { taskId: string; childId: string; attempt: number; runtimeId: string | null; source?: TaskSource; parentKey?: string };
export function taskGroupKey(row: Pick<Task, 'taskId' | 'source'>): string {
 return row.source ? JSON.stringify([row.source.agentId, row.source.workspaceId, row.source.sessionId, row.source.runtimeEpoch, row.taskId]) : row.taskId;
}
export function treeAttemptKey(row: Task): string {
 return JSON.stringify([taskGroupKey(row), row.childId, row.attempt, row.runtimeId]);
}
/** Preorder over exact attempt edges, not names; orphan/cyclic edges are omitted. */
export function orderTaskTree<T extends Task>(rows: T[]): { row: T; depth: number }[] {
 const byKey = new Map(rows.map(row => [treeAttemptKey(row), row]));
 const children = new Map<string, T[]>();
 for (const row of rows) if (row.parentKey && byKey.has(row.parentKey)) {
  const siblings = children.get(row.parentKey) ?? []; siblings.push(row); children.set(row.parentKey, siblings);
 }
 const result: { row: T; depth: number }[] = [], visited = new Set<string>();
 const visit = (row: T, depth: number) => {
  const key = treeAttemptKey(row);
  if (visited.has(key) || depth > 8 || result.length >= 2000) return;
  visited.add(key); result.push({ row, depth });
  for (const child of children.get(key) ?? []) visit(child, depth + 1);
 };
 for (const row of rows) if (!row.parentKey) visit(row, 0);
 return result;
}
