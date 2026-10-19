import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import {
	useRpc,
	type PluginAgentPanelProps,
	type PluginClientContext,
	type PluginButtonRegistration,
} from "@getpaseo/plugin/client";
import { harnessStatusRpc } from "../shared/harness-readonly";
import { observabilitySnapshotRpc } from "../shared/observability";

type Feature = "progress" | "stamp" | "cache";
const labels = {
	progress: "Progress",
	stamp: "Response stamps",
	cache: "Cache diagnostics",
};
export function contributeObservability(client: PluginClientContext) {
	const entries = new Map<
		string,
		{ workspace: string; button: PluginButtonRegistration }
	>();
	const lifetime = new AbortController();
	let stopped = false;
	const dispose = client.addWorkspacePanel({
		id: "pi-activity",
		title: "Pi activity",
		icon: "Activity",
		context: "agent",
		locations: ["workspace"],
		Component: ObservabilityPanel,
	});
	const remove = (id: string) => {
		entries.get(id)?.button.remove();
		entries.delete(id);
	};
	const register = (agent: {
		id: string;
		workspaceId?: string | null;
		provider?: string;
		archivedAt?: string | null;
	}) => {
		if (stopped) return;
		if (agent.provider !== "pi" || agent.archivedAt || !agent.workspaceId) {
			remove(agent.id);
			return;
		}
		if (entries.get(agent.id)?.workspace === agent.workspaceId) return;
		remove(agent.id);
		const workspaceId = agent.workspaceId;
		entries.set(agent.id, {
			workspace: workspaceId,
			button: client.addComposerPill({
				id: "pi-activity",
				agentId: agent.id,
				workspaceId,
				button: {
					label: "Activity",
					title: "Progress, response stamps and cache diagnostics",
					icon: "Activity",
					behavior: {
						kind: "action",
						onPress: () =>
							client.openPanel("pi-activity", {
								agentId: agent.id,
								workspaceId,
							}),
					},
				},
			}),
		});
	};
	void client.paseo.agents
		.list({ subscribe: {}, signal: lifetime.signal })
		.then(({ subscription }) => {
			if (stopped) return;
			subscription.subscribe({
				snapshot: ({ entries: agents }) => {
					const ids = new Set(agents.map(({ agent }) => agent.id));
					for (const id of entries.keys()) if (!ids.has(id)) remove(id);
					for (const { agent } of agents) register(agent);
				},
				update: (message) => {
					if (message.type === "agent_update") {
						if (message.payload.kind === "remove")
							remove(message.payload.agentId);
						else register(message.payload.agent);
					}
				},
			});
		})
		.catch((error) => {
			if (!stopped)
				console.error("Pi Activity subscription unavailable", error);
		});
	return () => {
		stopped = true;
		lifetime.abort();
		for (const id of entries.keys()) remove(id);
		dispose();
	};
}
const amount = (value: number | null | undefined, suffix = "") =>
	value == null
		? "unavailable"
		: `${Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2)}${suffix}`;
const money = (value: number | null | undefined) =>
	value == null ? "unavailable" : `est $${value.toFixed(6)}`;
export function ObservabilityPanel({
	agentId,
	workspaceId,
	theme,
	host,
}: PluginAgentPanelProps) {
	const [feature, setFeature] = useState<Feature>("progress");
	const status = useRpc(harnessStatusRpc),
		snapshot = useRpc(observabilitySnapshotRpc);
	const identity = useQuery({
		queryKey: ["pi-activity-identity", host.id, agentId, workspaceId],
		queryFn: () => status({ agentId, workspaceId }),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const session = identity.data?.sessionId,
		epoch = identity.data?.runtimeEpoch;
	const ready =
		identity.data?.available === true &&
		!!session &&
		!!epoch &&
		!identity.isError;
	const result = useQuery({
		queryKey: [
			"pi-activity",
			host.id,
			agentId,
			workspaceId,
			session,
			epoch,
			feature,
		],
		enabled: ready,
		queryFn: () =>
			snapshot({
				agentId,
				workspaceId,
				expectedSessionId: session!,
				expectedRuntimeEpoch: epoch!,
				feature,
			}),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const data =
		ready &&
		!result.isError &&
		result.data?.sessionId === session &&
		result.data?.feature === feature
			? result.data
			: undefined;
	const fg = theme.colors.foreground,
		muted = theme.colors.foregroundMuted;
	const line = (text: string, key?: string) => (
		<Text key={key} selectable style={{ color: fg }}>
			{text}
		</Text>
	);
	const button = (label: string, fn: () => void) => (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			onPress={fn}
			style={{ padding: 10 }}
		>
			<Text style={{ color: fg }}>{label}</Text>
		</Pressable>
	);
	return (
		<ScrollView
			style={{ flex: 1 }}
			contentContainerStyle={{ padding: 16, gap: 12 }}
		>
			<Text accessibilityRole="header" style={{ color: fg, fontSize: 18 }}>
				Pi activity
			</Text>
			<View style={{ flexDirection: "row", flexWrap: "wrap" }}>
				{(["progress", "stamp", "cache"] as Feature[]).map((f) => (
					<View key={f}>
						{button(`${feature === f ? "✓ " : ""}${labels[f]}`, () =>
							setFeature(f),
						)}
					</View>
				))}
			</View>
			{button("Refresh", () => {
				void identity.refetch();
				if (ready) void result.refetch();
			})}
			{identity.isPending ? line("Connecting…") : null}
			{!identity.isPending && !ready
				? line(
						"Activity unavailable. Check the Pi connection and reload the extensions.",
					)
				: null}
			{ready && result.isPending ? line("Loading…") : null}
			{ready && result.isError ? (
				<Text style={{ color: theme.colors.statusDanger }}>
					This feature is unavailable or the session changed. Enable the
					extension, reload Pi, and refresh.
				</Text>
			) : null}
			{data ? (
				<Text style={{ color: muted }}>
					Observed session state ·{" "}
					{data.lastUpdated ?? "update time unavailable"}
				</Text>
			) : null}
			{data?.feature === "progress" ? (
				<View style={{ gap: 8 }}>
					{line("Model-reported progress, not independent verification.")}
					{!data.data.steps.length ? line("No progress recorded.") : null}
					{data.data.steps.map((step, i) =>
						line(
							`${i + 1}. [${step.status.replace("_", " ")}] ${step.text}`,
							String(i),
						),
					)}
				</View>
			) : null}
			{data?.feature === "stamp" ? (
				<View style={{ gap: 12 }}>
					{line(
						"Latest 50 recorded stamps. Times are local Pi observations; costs are estimates.",
					)}
					{!data.data.records.length
						? line("No stamps recorded yet. Older messages are not backfilled.")
						: null}
					{data.data.records
						.slice()
						.reverse()
						.map((record) => (
							<View key={record.id} style={{ gap: 4 }}>
								{line(
									`${new Date(record.timestamp).toLocaleString()} · ${record.role}${record.tool ? ` · ${record.tool}` : ""}`,
								)}
								{record.model
									? line(
											`${record.provider}/${record.model}${record.thinking ? ` · thinking ${record.thinking}` : ""}`,
										)
									: null}
								{record.completedAt !== undefined
									? line(
											`Duration ${amount((record.completedAt - record.timestamp) / 1000, "s")}${record.firstContentAt !== undefined ? ` · first content ${amount((record.firstContentAt - record.timestamp) / 1000, "s")}` : ""}`,
										)
									: null}
								{record.outcome ? line(`Outcome: ${record.outcome}`) : null}
								{record.usage
									? line(
											`Input ${amount(record.usage.input)} · output ${amount(record.usage.output)} · cache read ${amount(record.usage.cacheRead)} · ${money(record.usage.estimatedCost)}`,
										)
									: null}
								{record.costSinceUser !== undefined
									? line(`Since user: ${money(record.costSinceUser)}`)
									: null}
							</View>
						))}
				</View>
			) : null}
			{data?.feature === "cache" ? (
				<View style={{ gap: 8 }}>
					{line(
						"Observed cache accounting, not a prediction or subscription quota.",
					)}
					{data.data.latest ? (
						<>
							{line(
								`${data.data.latest.provider}/${data.data.latest.model}${data.data.streaming ? " · streaming" : ""}`,
							)}
							{line(
								`Latest hit ${amount(data.data.latest.hitRatePercent, "%")} · uncached input ${amount(data.data.latest.input)} · cache read ${amount(data.data.latest.cacheRead)} · cache write ${amount(data.data.latest.cacheWrite)}`,
							)}
						</>
					) : (
						line(
							"No comparable cache accounting available yet. Missing cache data is not a proven miss.",
						)
					)}
					{data.data.comparison
						? line(
								`Request start gap ${amount(data.data.comparison.requestStartGapMs / 1000, "s")} · estimated re-billed tokens ${amount(data.data.comparison.rebilledTokens)} · miss premium ${money(data.data.comparison.estimatedMissPremium)}`,
							)
						: null}
					{line(
						`Active-branch totals: ${amount(data.data.session.requestCount)} requests · ${amount(data.data.session.promptTokens)} prompt tokens · weighted hit ${amount(data.data.session.hitRatePercent, "%")}`,
					)}
					{line(
						`Prompt cost ${money(data.data.session.promptCost)} · cache savings ${money(data.data.session.estimatedSavings)}`,
					)}
					{line(
						`Recent hit rates: ${data.data.trend.map((x) => amount(x, "%")).join(" → ") || "unavailable"}`,
					)}
				</View>
			) : null}
		</ScrollView>
	);
}
