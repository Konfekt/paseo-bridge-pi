import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachWorktreeDiffStats } from "../server/worktree-diff-stats.ts";

test("native workspace statistics join exact physical path/current project, never allocate or invent zero", async () => {
	const dir = await mkdtemp(join(tmpdir(), "worktree-stats-"));
	try {
		const tree = join(dir, "tree"), alias = join(dir, "alias"), other = join(dir, "other");
		await mkdir(tree); await mkdir(other); await symlink(tree, alias);
		const snapshot = { worktrees: [{ path: tree, diffStat: { additions: 9999, deletions: 9999 } }, { path: other }] } as any;
		let entries: any[] = [{ id: "foreign", projectId: "foreign", workspaceDirectory: tree, diffStat: { additions: 400, deletions: 900 } }, { id: "exact", projectId: "current", workspaceDirectory: alias, diffStat: { additions: 128, deletions: 34 } }];
		let partial = false, fail = false;
		const context = { paseo: { workspaces: {
			ref: () => ({ refresh: async () => ({ projectId: "current" }) }),
			list: async (options: any) => { assert.deepEqual(options.filter, { projectId: "current" }); if (fail) throw Error("unavailable"); return { entries, pageInfo: { hasMore: partial, nextCursor: null } }; },
			create: () => { throw Error("Statistics must not allocate"); },
		} } } as any;
		let result = await attachWorktreeDiffStats(snapshot, "parent", context);
		assert.deepEqual(result.worktrees[0].diffStat, { additions: 128, deletions: 34 });
		assert.equal(result.worktrees[1].diffStat, undefined);
		entries[1].diffStat = null;
		assert.equal((await attachWorktreeDiffStats(snapshot, "parent", context)).worktrees[0].diffStat, null, "native null retained, not replaced with zero");
		entries[1].diffStat = { additions: -1, deletions: 2 };
		assert.equal((await attachWorktreeDiffStats(snapshot, "parent", context)).worktrees[0].diffStat, null);
		entries.push({ ...entries[1], id: "ambiguous" });
		assert.equal((await attachWorktreeDiffStats(snapshot, "parent", context)).worktrees[0].diffStat, undefined);
		partial = true;
		assert.equal((await attachWorktreeDiffStats(snapshot, "parent", context)).worktrees[0].diffStat, undefined);
		partial = false; fail = true;
		assert.equal((await attachWorktreeDiffStats(snapshot, "parent", context)).worktrees[0].diffStat, undefined);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
