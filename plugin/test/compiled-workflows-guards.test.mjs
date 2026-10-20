import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, symlink, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url),
	root = fileURLToPath(new URL("../", import.meta.url));
test("worktree removal rechecks open Paseo agents including symlinked subdirectories and fails closed on incomplete inventory", {
	skip: !process.env.PASEO_PLUGIN_COMPILER,
}, async () => {
	const dir = await mkdtemp(join(tmpdir(), "worktree-guard-")),
		tree = join(dir, "tree"),
		alias = join(dir, "alias");
	await mkdir(tree);
	await mkdir(join(tree, "sub"));
	await symlink(tree, alias);
	try {
		const plugin = join(dir, "plugin"); await mkdir(plugin);
		await cp(resolve(root, "server"), join(plugin, "server"), { recursive: true });
		await cp(resolve(root, "shared"), join(plugin, "shared"), { recursive: true });
		await writeFile(join(plugin, "index.server.ts"), 'export { createWorkflowsHandlers } from "./server/workflows";');
		const { compilePlugin } = await import(
				pathToFileURL(resolve(process.env.PASEO_PLUGIN_COMPILER))
			),
			{ serverBundle } = await compilePlugin({
				server: join(plugin, "index.server.ts"),
			});
		const { createWorkflowsHandlers } = (0, eval)(serverBundle)((name) =>
			name === "@getpaseo/plugin" ? { defineRpc: (x) => x } : require(name),
		);
		const descriptor = {
			version: 1,
			socketPath: "/tmp/not-used",
			capability: "a".repeat(64),
			agentId: "agent",
			sessionId: "session",
			runtimeEpoch: randomUUID(),
			serviceEpoch: randomUUID(),
		};
		const op = randomUUID(),
			dialog = randomUUID();
		const state = {
			protocol: 1,
			sessionId: "session",
			serviceEpoch: descriptor.serviceEpoch,
			cwd: dir,
			model: "openai/gpt-6-luna",
			busy: true,
			idle: true,
			notice: null,
			operationId: op,
			operationAction: "worktree.remove",
			protectedPaths: [tree],
			dialog: {
				id: dialog,
				operationId: op,
				kind: "confirm",
				title: "Remove Git worktree",
				message: "Delete approved tree",
				options: [],
			},
			worktrees: [],
			worktreeError: null,
			worktreeLoading: false,
			goal: null,
			lastCompletion: null,
			limits: { automaticTurns: 3, noProgressTurns: 2 },
		};
		let mutations = 0,
			otherCwd = join(alias, "sub"),
			incomplete = false;
		const handlers = createWorkflowsHandlers(
			async () => descriptor,
			async (_d, r) => {
				if (r.operation !== "snapshot") mutations++;
				return state;
			},
		);
		const context = {
			paseo: {
				agents: {
					ref: () => ({
						refresh: async () => ({
							agent: { id: "agent", workspaceId: "workspace", provider: "pi" },
						}),
					}),
					list: async () => ({
						entries: [
							{
								agent: {
									id: "other",
									cwd: otherCwd,
									provider: "claude",
									archivedAt: null,
								},
							},
						],
						pageInfo: { hasMore: incomplete, nextCursor: null },
					}),
				},
			},
		};
		const input = {
			agentId: "agent",
			workspaceId: "workspace",
			expectedRuntimeEpoch: descriptor.runtimeEpoch,
			request: {
				operation: "send",
				sessionId: "session",
				serviceEpoch: descriptor.serviceEpoch,
				requestId: randomUUID(),
				operationId: op,
				dialogId: dialog,
				value: true,
			},
		};
		await assert.rejects(handlers.control(input, context), /open Paseo agent/);
		assert.equal(mutations, 0);
		otherCwd = dir;
		incomplete = true;
		await assert.rejects(
			handlers.control(input, context),
			/Incomplete agent inventory/,
		);
		assert.equal(mutations, 0);
		incomplete = false;
		await handlers.control(input, context);
		assert.equal(mutations, 1);
		await assert.rejects(
			handlers.control(
				{ ...input, request: { ...input.request, dialogId: randomUUID() } },
				context,
			),
			/confirmation changed/,
		);
		assert.equal(mutations, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
