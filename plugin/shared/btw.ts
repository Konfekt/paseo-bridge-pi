import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const id = z.string().min(1).max(256);
export const btwSnapshotSchema = z
	.object({
		protocol: z.literal(1),
		sessionId: id,
		serviceEpoch: z.string().uuid(),
		defaultModel: z.string().max(512),
		models: z.array(z.string().max(512)).max(256),
		threads: z
			.array(
				z
					.object({
						id: z.string().uuid(),
						model: z.string().max(512),
						context: z.enum(["recent", "none"]),
						contextTruncated: z.boolean(),
						state: z.enum(["idle", "running", "cancelled", "error"]),
						question: z.string().max(8000),
						partial: z.string().max(16000),
						error: z.string().max(500).nullable(),
						turnCount: z.number().int().min(0).max(16),
						turns: z
							.array(
								z
									.object({
										question: z.string().max(8000),
										answer: z.string().max(16000),
									})
									.strict(),
							)
							.max(16),
					})
					.strict(),
			)
			.max(8),
	})
	.strict();
const target = { agentId: id, workspaceId: id };
export const btwStatusRpc = defineRpc({
	name: "btw_status",
	input: z
		.object({ ...target, threadId: z.string().uuid().optional() })
		.strict(),
	output: z
		.object({
			available: z.boolean(),
			sessionId: id.nullable(),
			runtimeEpoch: z.string().uuid().nullable(),
			snapshot: btwSnapshotSchema.nullable(),
		})
		.strict(),
});
const base = {
	sessionId: id,
	serviceEpoch: z.string().uuid(),
	requestId: z.string().uuid(),
	threadId: z.string().uuid(),
};
export const btwRequestSchema = z.discriminatedUnion("operation", [
	z
		.object({
			...base,
			operation: z.literal("start"),
			question: z.string().trim().min(1).max(8000),
			model: z.string().min(1).max(512),
			context: z.enum(["recent", "none"]),
		})
		.strict(),
	z
		.object({
			...base,
			operation: z.literal("send"),
			question: z.string().trim().min(1).max(8000),
		})
		.strict(),
	z.object({ ...base, operation: z.literal("cancel") }).strict(),
	z.object({ ...base, operation: z.literal("remove") }).strict(),
]);
export const btwControlRpc = defineRpc({
	name: "btw_control",
	input: z
		.object({
			...target,
			expectedRuntimeEpoch: z.string().uuid(),
			request: btwRequestSchema,
		})
		.strict(),
	output: btwSnapshotSchema,
});
export type BtwSnapshot = z.infer<typeof btwSnapshotSchema>;
export type BtwRequest = z.infer<typeof btwRequestSchema>;
