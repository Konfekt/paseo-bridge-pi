import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const id = z.string().min(1).max(256);
export const workflowSnapshotSchema = z
	.object({
		protocol: z.literal(1),
		sessionId: id,
		serviceEpoch: z.string().uuid(),
		cwd: z.string().max(4096),
		model: z.string().max(512).nullable(),
		busy: z.boolean(),
		idle: z.boolean(),
		notice: z.string().max(6000).nullable(),
		operationId: z.string().uuid().nullable(),
		operationAction: z.string().max(64).nullable(),
		protectedPaths: z.array(z.string().max(4096)).max(100),
		dialog: z
			.object({
				id: z.string().uuid(),
				operationId: z.string().uuid(),
				kind: z.enum(["input", "select", "confirm"]),
				title: z.string().max(48000),
				message: z.string().max(48000),
				options: z.array(z.string().max(48000)).max(200),
			})
			.strict()
			.nullable(),
		worktrees: z
			.array(
				z
					.object({
						path: z.string().max(4096),
						branch: z.string().max(4096).nullable(),
						head: z.string().max(64).nullable(),
						main: z.boolean(),
						current: z.boolean(),
						locked: z.boolean(),
						stale: z.boolean(),
						detached: z.boolean(),
					})
					.strict(),
			)
			.max(100),
		worktreeError: z.string().max(2000).nullable(),
		worktreeLoading: z.boolean(),
		goal: z
			.object({
				id,
				text: z.string().max(4000),
				status: z.enum([
					"active",
					"paused",
					"blocked",
					"usage_limited",
					"budget_limited",
					"complete",
				]),
				waiting: z.string().max(1000).nullable(),
				iteration: z.number().nonnegative(),
				tokensUsed: z.number().nonnegative(),
				tokenBudget: z.number().positive().nullable(),
				automaticTurns: z.number().nonnegative(),
				noProgressTurns: z.number().nonnegative(),
				safetyPauseCause: z.string().max(100).nullable(),
				summary: z.string().max(6000).nullable(),
			})
			.strict()
			.nullable(),
		lastCompletion: z
			.object({
				id,
				text: z.string().max(4000),
				summary: z.string().max(4000).nullable(),
			})
			.strict()
			.nullable(),
		limits: z
			.object({
				automaticTurns: z.number().positive().nullable(),
				noProgressTurns: z.number().positive().nullable(),
			})
			.strict(),
	})
	.strict();
const base = {
	sessionId: id,
	serviceEpoch: z.string().uuid(),
	requestId: z.string().uuid(),
};
export const workflowRequestSchema = z.discriminatedUnion("operation", [
	z
		.object({
			...base,
			operation: z.literal("start"),
			action: z.enum([
				"worktree.add",
				"worktree.remove",
				"worktree.prune",
				"worktree.open",
				"goal.start",
				"goal.edit",
				"goal.pause",
				"goal.resume",
				"goal.clear",
			]),
			expectedGoalId: id.nullable(),
			objective: z.string().max(4000).optional(),
			tokenBudget: z.number().int().positive().max(1_000_000).optional(),
			path: z.string().max(4096).optional(),
		})
		.strict(),
	z
		.object({
			...base,
			operation: z.literal("send"),
			operationId: z.string().uuid(),
			dialogId: z.string().uuid(),
			value: z.union([z.string().max(8000), z.boolean(), z.null()]),
		})
		.strict(),
	z
		.object({
			...base,
			operation: z.literal("cancel"),
			operationId: z.string().uuid(),
		})
		.strict(),
]);
const target = { agentId: id, workspaceId: id };
export const workflowsStatusRpc = defineRpc({
	name: "workflows_status",
	input: z.object(target).strict(),
	output: z
		.object({
			available: z.boolean(),
			sessionId: id.nullable(),
			runtimeEpoch: z.string().uuid().nullable(),
			snapshot: workflowSnapshotSchema.nullable(),
		})
		.strict(),
});
export const workflowsControlRpc = defineRpc({
	name: "workflows_control",
	input: z
		.object({
			...target,
			expectedRuntimeEpoch: z.string().uuid(),
			request: workflowRequestSchema,
		})
		.strict(),
	output: z
		.object({
			snapshot: workflowSnapshotSchema,
			openedWorkspaceId: id.nullable(),
		})
		.strict(),
});
export type WorkflowSnapshot = z.infer<typeof workflowSnapshotSchema>;
export type WorkflowRequest = z.infer<typeof workflowRequestSchema>;
