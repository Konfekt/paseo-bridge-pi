import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { btwSnapshotSchema, btwStatusRpc, btwControlRpc } from "../shared/btw";
import {
	callBtw,
	readBtwDescriptor,
	validateBtwDescriptor,
	type BtwDescriptor,
} from "./btw-transport";
export function createBtwHandlers(read = readBtwDescriptor, call = callBtw) {
	async function target(
		input: { agentId: string; workspaceId: string },
		context: PluginHandlerContext,
	) {
		const current = await context.paseo.agents.ref(input.agentId).refresh();
		if (
			!current ||
			current.agent.id !== input.agentId ||
			current.agent.workspaceId !== input.workspaceId ||
			current.agent.provider !== "pi"
		)
			throw new Error("BTW target no longer matches this Pi workspace");
	}
	async function recheck(
		input: { agentId: string; workspaceId: string },
		context: PluginHandlerContext,
		descriptor: BtwDescriptor,
	) {
		await target(input, context);
		const current = await read(input.agentId);
		if (
			!validateBtwDescriptor(current, input.agentId) ||
			["sessionId", "runtimeEpoch", "serviceEpoch", "capability"].some(
				(k) =>
					current[k as keyof BtwDescriptor] !==
					descriptor[k as keyof BtwDescriptor],
			)
		)
			throw new Error("BTW session changed; refresh");
	}
	return {
		status: async (
			input: RpcInput<typeof btwStatusRpc>,
			context: PluginHandlerContext,
		) => {
			await target(input, context);
			const d = await read(input.agentId);
			const unavailable = {
				available: false,
				sessionId: null,
				runtimeEpoch: null,
				snapshot: null,
			};
			if (!validateBtwDescriptor(d, input.agentId)) return unavailable;
			const snapshot = btwSnapshotSchema.parse(
				await call(d, {
					operation: "snapshot",
					sessionId: d.sessionId,
					serviceEpoch: d.serviceEpoch,
					...(input.threadId ? { threadId: input.threadId } : {}),
				}),
			);
			await recheck(input, context, d);
			if (
				snapshot.sessionId !== d.sessionId ||
				snapshot.serviceEpoch !== d.serviceEpoch
			)
				throw new Error("BTW service identity mismatch");
			return {
				available: true,
				sessionId: d.sessionId,
				runtimeEpoch: d.runtimeEpoch,
				snapshot,
			};
		},
		control: async (
			input: RpcInput<typeof btwControlRpc>,
			context: PluginHandlerContext,
		) => {
			await target(input, context);
			const d = await read(input.agentId);
			if (
				!validateBtwDescriptor(d, input.agentId) ||
				d.runtimeEpoch !== input.expectedRuntimeEpoch ||
				d.sessionId !== input.request.sessionId ||
				d.serviceEpoch !== input.request.serviceEpoch
			)
				throw new Error("BTW target changed; no request sent");
			const snapshot = btwSnapshotSchema.parse(await call(d, input.request));
			await recheck(input, context, d);
			if (
				snapshot.sessionId !== d.sessionId ||
				snapshot.serviceEpoch !== d.serviceEpoch
			)
				throw new Error("BTW service changed");
			return snapshot;
		},
	};
}
