import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const number = z.number().finite().nonnegative();
const text = z.string().max(4096);
const usage = z.object({
	input: number.optional(),
	output: number.optional(),
	reasoning: number.optional(),
	cacheRead: number.optional(),
	cacheWrite: number.optional(),
	totalTokens: number.optional(),
	estimatedCost: number.optional(),
});
const common = {
	protocol: z.literal(1),
	state: z.literal("available"),
	sessionId: z.string().min(1).max(256),
	lastUpdated: z.string().nullable(),
	stale: z.literal(false),
};
export const observabilitySnapshotSchema = z.discriminatedUnion("feature", [
	z.object({
		...common,
		feature: z.literal("stamp"),
		data: z.object({
			records: z
				.array(
					z.object({
						id: z.string().max(256),
						role: z.enum(["user", "assistant", "tool"]),
						timestamp: number,
						completedAt: number.optional(),
						firstContentAt: number.optional(),
						tool: text.optional(),
						outcome: z.string().max(40).optional(),
						model: text.optional(),
						provider: text.optional(),
						thinking: z.string().max(20).optional(),
						usage: usage.optional(),
						costSinceUser: number.optional(),
						timeSinceUserMs: number.optional(),
					}),
				)
				.max(50),
		}),
	}),
	z.object({
		...common,
		feature: z.literal("progress"),
		data: z.object({
			steps: z
				.array(
					z.object({
						text,
						status: z.enum(["pending", "in_progress", "completed", "blocked"]),
					}),
				)
				.max(50),
		}),
	}),
	z.object({
		...common,
		feature: z.literal("cache"),
		data: z.object({
			streaming: z.boolean(),
			requestNumber: number,
			latest: z
				.object({
					provider: text,
					model: text,
					timestamp: number,
					input: number,
					cacheRead: number,
					cacheWrite: number,
					promptTokens: number,
					hitRatePercent: number.nullable(),
					promptCost: number.nullable(),
				})
				.nullable(),
			session: z.object({
				requestCount: number,
				input: number,
				cacheRead: number,
				cacheWrite: number,
				promptTokens: number,
				hitRatePercent: number.nullable(),
				promptCost: number.nullable(),
				estimatedSavings: number.nullable(),
			}),
			comparison: z
				.object({
					requestStartGapMs: number,
					rebilledTokens: number,
					estimatedMissPremium: number.nullable(),
				})
				.nullable(),
			trend: z.array(number).max(8),
		}),
	}),
]);
export const observabilitySnapshotRpc = defineRpc({
	name: "observability_snapshot",
	input: z.object({
		agentId: z.string().min(1).max(256),
		workspaceId: z.string().min(1).max(256),
		expectedSessionId: z.string().min(1).max(256),
		expectedRuntimeEpoch: z.string().uuid(),
		feature: z.enum(["stamp", "progress", "cache"]),
	}),
	output: observabilitySnapshotSchema,
});
