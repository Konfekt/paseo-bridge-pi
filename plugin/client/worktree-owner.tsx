import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { useAgent, useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { harnessStatusRpc, harnessSubagentsListRpc, harnessSubagentRouteRpc } from "../shared/harness-readonly";
import { recordedAgentDisplayName, recordedAgentRoute, type RecordedWorktreeOwner, type WorktreeAgentEvidence, type WorktreeAgentSource } from "../shared/worktree-agent";
import { NativeButton } from "./presentation";
import { WorkStatusRing } from "./work-status-ring";

type Props = Pick<PluginAgentPanelProps, "host" | "agentId" | "workspaceId" | "theme" | "layout"> & {
	owner: RecordedWorktreeOwner;
	sessionId: string;
	runtimeEpoch: string;
	onOpenAgent?: (agentId: string) => void;
};

/** A recorded owner is not exhaustive assignment membership or proof of a running worker. */
export function WorktreeOwner({ owner, sessionId, runtimeEpoch, onOpenAgent, ...props }: Props) {
	const status = useRpc(harnessStatusRpc), list = useRpc(harnessSubagentsListRpc), route = useRpc(harnessSubagentRouteRpc);
	const [pending, setPending] = useState(false), [error, setError] = useState<string>();
	const mounted = useRef(true), current = useRef("");
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const query = useQuery({
		queryKey: ["pi-worktree-owner", props.host.id, props.workspaceId, props.agentId, sessionId, runtimeEpoch, owner.ownerSessionId, owner.taskId, owner.childId],
		queryFn: async () => {
			const bound = await status({ agentId: props.agentId, workspaceId: props.workspaceId });
			if (!bound.available || bound.sessionId !== sessionId || bound.runtimeEpoch !== runtimeEpoch)
				return { request: null, status: undefined, reason: "Owner session unavailable" };
			const root: WorktreeAgentSource = { agentId: props.agentId, workspaceId: props.workspaceId, sessionId, runtimeEpoch };
			const items: (WorktreeAgentEvidence & { status: string })[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < 4; page++) {
				const result = await list({ agentId: props.agentId, workspaceId: props.workspaceId, expectedSessionId: sessionId, expectedRuntimeEpoch: runtimeEpoch, includeDescendants: owner.ownerSessionId !== sessionId, limit: 50, cursor });
				if (result.state !== "available" || result.stale || result.sessionId !== sessionId || result.hierarchyPartial)
					return { request: null, status: undefined, reason: "Owner inventory unavailable or incomplete" };
				items.push(...result.items);
				cursor = result.nextCursor;
				if (!cursor) break;
			}
			const request = recordedAgentRoute(owner, root, items, !cursor);
			const matched = request && items.find(item => item.taskId === request.taskId && item.childId === request.childId && (item.source ?? root).sessionId === request.sessionId);
			return { request, status: matched?.status,
				nativeAgentId: matched && "paseoAgentId" in matched && typeof matched.paseoAgentId === "string" ? matched.paseoAgentId : undefined,
				nativeWorkspaceId: matched && "paseoWorkspaceId" in matched && typeof matched.paseoWorkspaceId === "string" ? matched.paseoWorkspaceId : undefined,
				reason: request ? undefined : "No verified current conversation for this recorded owner" };
		},
		refetchInterval: 5000,
		staleTime: 0,
	});
	const evidence = query.data;
	const native = useAgent(evidence?.nativeAgentId ?? "", agent => ({ id: agent.id, workspaceId: agent.workspaceId, title: agent.title }));
	const request = !query.isError && !query.isFetching ? evidence?.request : null;
	// Correlated current runtime + matching native workspace only; never use task/title fallback.
	const name = recordedAgentDisplayName(owner,
		request && evidence?.nativeAgentId && evidence.nativeWorkspaceId ? { agentId: evidence.nativeAgentId, workspaceId: evidence.nativeWorkspaceId } : null,
		native);
	const requestKey = JSON.stringify(request ?? null);
	current.current = requestKey;
	useEffect(() => { if (evidence?.request && !query.isError) setError(undefined); }, [query.dataUpdatedAt]);
	const reason = error ?? (!onOpenAgent ? "Chat navigation unavailable on this host" : query.isError ? "Owner inventory unavailable" : query.isPending || query.isFetching ? "Verifying owner conversation…" : evidence?.reason);
	const colors = props.theme.colors, state = request && !error ? evidence?.status : undefined;
	async function open() {
		if (!request || pending || !onOpenAgent) return;
		setPending(true); setError(undefined);
		try {
			const resolved = await route({ agentId: request.agentId, workspaceId: request.workspaceId, expectedSessionId: request.sessionId, expectedRuntimeEpoch: request.runtimeEpoch, taskId: request.taskId, childId: request.childId, groupId: request.groupId, runtimeId: request.runtimeId, attempt: request.attempt });
			if (mounted.current && current.current === requestKey) onOpenAgent(resolved.agentId);
		} catch {
			if (mounted.current && current.current === requestKey) setError("Owner conversation changed or is unavailable; refresh before opening");
		} finally { if (mounted.current) setPending(false); }
	}
	return <View style={{ gap: 4 }}>
		<Text accessibilityRole="header" style={{ color: colors.foregroundMuted, fontSize: 12 }}>Recorded owner</Text>
		<View style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
			{state && ["starting", "launching", "pending", "running"].includes(state)
				? <View accessibilityLabel="Running"><WorkStatusRing attention={false} foreground={colors.foreground} platform={props.layout.platform} /></View>
				: <View accessibilityLabel={state === "failed" || state === "lost" ? "Failed or lost" : state ? "Idle" : "Owner status unknown"} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: !state ? colors.foregroundMuted : ["failed", "lost"].includes(state) ? colors.statusDanger : colors.statusSuccess }} />}
			<Text numberOfLines={2} style={{ color: colors.foreground, flex: 1, minWidth: 0 }}>{name ?? "Name unavailable"}</Text>
			<NativeButton colors={colors} label={pending ? "Opening…" : "Open"} disabled={!request || !onOpenAgent || pending || !!error} onPress={() => void open()} style={{ minHeight: 44 }} />
		</View>
		{reason ? <Text accessibilityRole={error ? "alert" : undefined} style={{ color: error ? colors.statusDanger : colors.foregroundMuted, fontSize: 12 }}>{reason}</Text> : null}
	</View>;
}
