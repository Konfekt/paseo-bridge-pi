import { createHash } from "node:crypto";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { UsageReport } from "@getpaseo/plugin/server/usage";
import { readHarnessDescriptor } from "./harness-readonly";
import {
	callHarnessReadOnly,
	validateHarnessReadOnlyDescriptor,
} from "./harness-readonly-transport";
import { observabilitySnapshotSchema } from "../shared/observability";

const inputSchema = z
	.object({
		agentId: z.string().min(1).max(256),
		sessionId: z.string().min(1).max(256),
		runtimeEpoch: z.string().uuid(),
		sample: z.number().int().nonnegative(),
	})
	.strict();
const count = (value: number) => Math.round(value).toLocaleString("en-US");
const percent = (value: number | null) =>
	value === null ? "Not reported" : `${value.toFixed(1)}%`;

/** Native context/usage surface, using details rather than pretending cache hits are quota. */
export function registerCacheUsage(server: PluginServerContext) {
	server.registerUsageSource({
		id: "pi-cache",
		label: "Prompt cache",
		input: inputSchema,
		async discover(scope) {
			if (scope.kind !== "session" || scope.provider !== "pi") return [];
			// Supplied authoritatively by the daemon, not inherited from a parent worker.
			const agentId = scope.env.PASEO_AGENT_ID;
			if (!agentId) return [];
			const descriptor = await readHarnessDescriptor(agentId);
			if (!validateHarnessReadOnlyDescriptor(descriptor, agentId)) return [];
			return [
				{
					key: createHash("sha256")
						.update(`pi-cache\0${agentId}\0${descriptor.sessionId}`)
						.digest("hex"),
					harness: "Pi",
					sessionOnly: true,
					// Local metrics must not inherit the five-minute quota cache. No provider call.
					input: {
						agentId,
						sessionId: descriptor.sessionId,
						runtimeEpoch: descriptor.runtimeEpoch,
						sample: Math.floor(Date.now() / 5000),
					},
				},
			];
		},
		async fetch(raw): Promise<UsageReport> {
			const input = inputSchema.parse(raw);
			try {
				const before = await readHarnessDescriptor(input.agentId);
				if (
					!validateHarnessReadOnlyDescriptor(before, input.agentId) ||
					before.sessionId !== input.sessionId ||
					before.runtimeEpoch !== input.runtimeEpoch
				)
					throw new Error("Session unavailable");
				const snapshot = observabilitySnapshotSchema.parse(
					await callHarnessReadOnly(before, "observability.snapshot", {
						sessionId: before.sessionId,
						feature: "cache",
					}),
				);
				const after = await readHarnessDescriptor(input.agentId);
				if (
					!validateHarnessReadOnlyDescriptor(after, input.agentId) ||
					after.sessionId !== before.sessionId ||
					after.runtimeEpoch !== before.runtimeEpoch ||
					after.capability !== before.capability ||
					snapshot.sessionId !== before.sessionId ||
					snapshot.feature !== "cache"
				)
					throw new Error("Session changed");
				const { latest, session } = snapshot.data;
				return {
					status: "available",
					windows: [],
					details: [
						{
							id: "latest-hit",
							label: "Last request hit",
							value: percent(latest?.hitRatePercent ?? null),
						},
						{
							id: "session-hit",
							label: "Session hit",
							value: percent(session.hitRatePercent),
						},
						{
							id: "cached-input",
							label: "Cached input tokens",
							value: count(session.cacheRead),
						},
						{
							id: "fresh-input",
							label: "Fresh input tokens",
							value: count(session.input),
						},
						...(session.cacheWrite
							? [
									{
										id: "cache-write",
										label: "Cache-write tokens",
										value: count(session.cacheWrite),
									},
								]
							: []),
					],
				};
			} catch {
				return {
					status: "error",
					error:
						"Current Pi cache metrics are unavailable. Reconnect or reload Pi, then refresh.",
				};
			}
		},
	});
}
