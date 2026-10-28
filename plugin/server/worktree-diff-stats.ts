import { realpath } from "node:fs/promises";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { WorkflowSnapshot } from "../shared/workflows";

/** Read native server statistics, without allocating workspaces or guessing counts.
 * A missing/partial inventory must not turn into an authoritative zero.
 */
export async function attachWorktreeDiffStats(snapshot: WorkflowSnapshot, workspaceId: string, context: PluginHandlerContext): Promise<WorkflowSnapshot> {
	const rows = snapshot.worktrees.map(({ diffStat: _ignored, ...tree }) => tree);
	try {
		const parent = await context.paseo.workspaces.ref(workspaceId).refresh();
		if (!parent) return { ...snapshot, worktrees: rows };
		const stats = new Map<string, { additions: number; deletions: number } | null>();
		const ambiguous = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; ; page++) {
			if (page >= 25) return { ...snapshot, worktrees: rows };
			const listed = await context.paseo.workspaces.list({ filter: { projectId: parent.projectId }, page: { limit: 200, cursor } });
			for (const workspace of listed.entries) {
				if (workspace.projectId !== parent.projectId || !workspace.workspaceDirectory) continue;
				const path = await realpath(workspace.workspaceDirectory).catch(() => null);
				if (!path) continue;
				if (stats.has(path)) { ambiguous.add(path); continue; }
				const value = workspace.diffStat;
				stats.set(path, value && Number.isSafeInteger(value.additions) && value.additions >= 0 && Number.isSafeInteger(value.deletions) && value.deletions >= 0 ? value : null);
			}
			if (listed.pageInfo?.hasMore === false) break;
			if (!listed.pageInfo?.nextCursor || listed.pageInfo.nextCursor === cursor) return { ...snapshot, worktrees: rows };
			cursor = listed.pageInfo.nextCursor;
		}
		return { ...snapshot, worktrees: await Promise.all(rows.map(async tree => {
			const path = await realpath(tree.path).catch(() => null);
			return path && stats.has(path) && !ambiguous.has(path) ? { ...tree, diffStat: stats.get(path)! } : tree;
		})) };
	} catch { return { ...snapshot, worktrees: rows }; }
}
