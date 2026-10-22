import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { Metadata, NativeRow, SectionHeading } from "./presentation";
import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { harnessStatusRpc } from "../shared/harness-readonly";
import { observabilitySnapshotRpc } from "../shared/observability";
import {
	count,
	cost,
	duration,
	percent,
	prioritizeSteps,
	progressSummary,
} from "../shared/activity-display";

type Snapshot = RpcOutput<typeof observabilitySnapshotRpc>;
type Feature = Snapshot["feature"];
export type Colors = PluginAgentPanelProps["theme"]["colors"];
type Stamp = Extract<Snapshot, { feature: "stamp" }>["data"]["records"][number];
type State = { data?: Snapshot; pending: boolean; error: boolean };

function Toggle({
	label,
	onPress,
	expanded,
	colors,
}: {
	label: string;
	onPress(): void;
	expanded?: boolean;
	colors: Colors;
}) {
	return <NativeRow colors={colors} title={label} trailing={expanded === undefined ? null : <Metadata colors={colors}>{expanded ? "⌃" : "⌄"}</Metadata>} expanded={expanded} onPress={onPress} />;
}
function Meter({
	value,
	label,
	colors,
	tone,
}: {
	value: number | null;
	label: string;
	colors: Colors;
	tone?: string;
}) {
	const bounded = percent(value);
	return (
		<View
			accessibilityRole="progressbar"
			accessibilityLabel={label}
			accessibilityValue={
				bounded === null
					? { text: "Unavailable" }
					: { min: 0, max: 100, now: bounded }
			}
			style={{
				height: 7,
				borderRadius: 4,
				backgroundColor: colors.surface2,
				overflow: "hidden",
			}}
		>
			{bounded === null ? null : (
				<View
					style={{
						width: `${bounded}%`,
						height: 7,
						borderRadius: 4,
						backgroundColor: tone ?? colors.accent,
					}}
				/>
			)}
		</View>
	);
}
function Stat({
	label,
	value,
	colors,
}: {
	label: string;
	value: string;
	colors: Colors;
}) {
	return (
		<View style={{ flexBasis: "45%", flexGrow: 1, minWidth: 100, gap: 3 }}>
			<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
				{label}
			</Text>
			<Text
				selectable
				style={{
					color: colors.foreground,
					fontSize: 17,
					fontWeight: "600",
					fontVariant: ["tabular-nums"],
				}}
			>
				{value}
			</Text>
		</View>
	);
}
function Message({
	state,
	empty,
	colors,
}: {
	state: State;
	empty?: string;
	colors: Colors;
}) {
	return (
		<Text
			style={{
				color: state.error ? colors.statusDanger : colors.foregroundMuted,
				fontSize: 13,
			}}
		>
			{state.error
				? "Unavailable · refresh to retry"
				: state.pending
					? "Loading…"
					: (empty ?? "Enable this extension and reload Pi.")}
		</Text>
	);
}
function ProgressSection({ state, colors }: { state: State; colors: Colors }) {
	const [expanded, setExpanded] = useState(false);
	const data = state.data?.feature === "progress" ? state.data.data : undefined;
	const summary = progressSummary(data?.steps ?? []);
	const ordered = prioritizeSteps(data?.steps ?? []);
	const rows = expanded ? ordered : ordered.slice(0, 4);
	const tones = {
		pending: colors.foregroundMuted,
		in_progress: colors.accent,
		completed: colors.statusSuccess,
		blocked: colors.statusWarning,
	};
	const icons = {
		pending: "○",
		in_progress: "●",
		completed: "✓",
		blocked: "!",
	};
	return (
		<SettingsSection
			title="Progress"
			trailing={
				data && summary.total ? (
					<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
						{summary.completed}/{summary.total} complete
					</Text>
				) : undefined
			}
		>
			<SettingsCard>
				<View style={{ padding: 16, gap: 12 }}>
					{!data ? (
						<Message state={state} colors={colors} />
					) : !summary.total ? (
						<Message state={state} colors={colors} empty="No steps yet" />
					) : (
						<>
							<Meter
								colors={colors}
								value={summary.percent}
								label={`${summary.completed} of ${summary.total} steps completed`}
								tone={
									summary.completed === summary.total
										? colors.statusSuccess
										: colors.accent
								}
							/>
							{rows.map(({ step, index }) => (
								<View
									key={index}
									style={{
										flexDirection: "row",
										gap: 10,
										alignItems: "flex-start",
									}}
								>
									<Text
										accessibilityLabel={step.status.replace("_", " ")}
										style={{
											color: tones[step.status],
											width: 18,
											fontWeight: "700",
											fontSize: 15,
										}}
									>
										{icons[step.status]}
									</Text>
									<View style={{ flex: 1, gap: 2 }}>
										<Text
											selectable
											style={{
												color:
													step.status === "completed"
														? colors.foregroundMuted
														: colors.foreground,
												fontSize: 14,
												lineHeight: 21,
											}}
										>
											{step.text}
										</Text>
										{step.status === "blocked" ? (
											<Text
												style={{
													color: colors.statusWarning,
													fontSize: 11,
													fontWeight: "600",
												}}
											>
												Blocked
											</Text>
										) : null}
									</View>
								</View>
							))}
							{ordered.length > 4 ? (
								<Toggle
									colors={colors}
									expanded={expanded}
									label={
										expanded
											? "Show fewer steps"
											: `Show all ${ordered.length} steps`
									}
									onPress={() => setExpanded(!expanded)}
								/>
							) : null}
						</>
					)}
				</View>
			</SettingsCard>
		</SettingsSection>
	);
}
function CacheSection({ state, colors }: { state: State; colors: Colors }) {
	const [expanded, setExpanded] = useState(false);
	const data = state.data?.feature === "cache" ? state.data.data : undefined;
	const hit = percent(data?.latest?.hitRatePercent);
	return (
		<SettingsSection title="Cache">
			<SettingsCard>
				<View style={{ padding: 16, gap: 14 }}>
					{!data ? (
						<Message state={state} colors={colors} />
					) : (
						<>
							<View
								style={{
									flexDirection: "row",
									alignItems: "center",
									justifyContent: "space-between",
									gap: 12,
								}}
							>
								<View style={{ gap: 3 }}>
									<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
										Observed cache accounting
									</Text>
									<Text
										style={{
											color: colors.foreground,
											fontSize: 30,
											fontWeight: "600",
											fontVariant: ["tabular-nums"],
										}}
									>
										{hit === null ? "—" : `${hit.toFixed(0)}%`}
									</Text>
								</View>
								<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
									{hit === null
										? "Awaiting data"
										: data.streaming
											? "Streaming"
											: "Latest request"}
								</Text>
							</View>
							<Meter colors={colors} value={hit} label="Cache hit rate" />
							<View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
								<Stat
									colors={colors}
									label="Uncached input"
									value={count(data.latest?.input)}
								/>
								<Stat
									colors={colors}
									label="Cached input"
									value={count(data.latest?.cacheRead)}
								/>
								<Stat
									colors={colors}
									label="Session input · estimated"
									value={cost(data.session.promptCost)}
								/>
								<Stat
									colors={colors}
									label="Cache savings · estimated"
									value={cost(data.session.estimatedSavings)}
								/>
							</View>
							<Toggle
								colors={colors}
								expanded={expanded}
								label="Cache details"
								onPress={() => setExpanded(!expanded)}
							/>
							{expanded ? (
								<View style={{ gap: 12 }}>
									{data.latest ? (
										<Text
											selectable
											style={{ color: colors.foregroundMuted, fontSize: 12 }}
										>
											{data.latest.provider}/{data.latest.model}
										</Text>
									) : null}
									<View
										style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}
									>
										<Stat
											colors={colors}
											label="Session requests"
											value={count(data.session.requestCount)}
										/>
										<Stat
											colors={colors}
											label="Session prompt tokens"
											value={count(data.session.promptTokens)}
										/>
										<Stat
											colors={colors}
											label="Weighted cache hit"
											value={
												data.session.hitRatePercent == null
													? "—"
													: `${data.session.hitRatePercent.toFixed(1)}%`
											}
										/>
										<Stat
											colors={colors}
											label="Cache writes"
											value={count(data.latest?.cacheWrite)}
										/>
										<Stat
											colors={colors}
											label="Request gap"
											value={duration(data.comparison?.requestStartGapMs)}
										/>
										<Stat
											colors={colors}
											label="Re-billed tokens · estimated"
											value={count(data.comparison?.rebilledTokens)}
										/>
										<Stat
											colors={colors}
											label="Miss premium · estimated"
											value={cost(data.comparison?.estimatedMissPremium)}
										/>
									</View>
									{data.trend.length ? (
										<View
											accessibilityLabel={`Recent cache hit rates: ${data.trend.map((x) => `${Math.round(x)}%`).join(", ")}`}
											style={{ gap: 6 }}
										>
											<Text
												style={{ color: colors.foregroundMuted, fontSize: 12 }}
											>
												Recent cache hits
											</Text>
											<View
												style={{
													height: 28,
													flexDirection: "row",
													alignItems: "flex-end",
													gap: 4,
												}}
											>
												{data.trend.map((value, index) => (
													<View
														key={index}
														style={{
															flex: 1,
															height: `${percent(value) ?? 0}%`,
															minHeight: 2,
															borderRadius: 3,
															backgroundColor: colors.accent,
														}}
													/>
												))}
											</View>
										</View>
									) : null}
								</View>
							) : null}
						</>
					)}
				</View>
			</SettingsCard>
		</SettingsSection>
	);
}
function ResponseRow({ record, colors }: { record: Stamp; colors: Colors }) {
	const [expanded, setExpanded] = useState(false);
	const elapsed =
		record.completedAt === undefined
			? undefined
			: record.completedAt - record.timestamp;
	const timestamp = new Date(record.timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const outcome =
		record.outcome && record.outcome !== "stop" ? record.outcome : undefined;
	return (
		<View style={{ borderBottomWidth: 1, borderBottomColor: colors.border }}>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`Response details ${record.id}`}
				accessibilityState={{ expanded }}
				onPress={() => setExpanded(!expanded)}
				style={{ minHeight: 48, paddingVertical: 12, gap: 6 }}
			>
				<View
					style={{
						flexDirection: "row",
						justifyContent: "space-between",
						gap: 12,
					}}
				>
					<Text
						numberOfLines={1}
						style={{
							flex: 1,
							color: colors.foreground,
							fontSize: 14,
							fontWeight: "500",
						}}
					>
						{record.model ?? "Assistant"}
					</Text>
					<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
						{timestamp} {expanded ? "⌃" : "⌄"}
					</Text>
				</View>
				<View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
					{elapsed !== undefined ? (
						<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
							{duration(elapsed)}
						</Text>
					) : null}
					{record.usage?.estimatedCost !== undefined ? (
						<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
							{cost(record.usage.estimatedCost)} est.
						</Text>
					) : null}
					{record.thinking ? (
						<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
							{record.thinking}
						</Text>
					) : null}
					{outcome ? (
						<Text
							style={{
								color:
									outcome === "error"
										? colors.statusDanger
										: colors.foregroundMuted,
								fontSize: 12,
							}}
						>
							{outcome === "toolUse" ? "Tools" : outcome}
						</Text>
					) : null}
				</View>
			</Pressable>
			{expanded ? (
				<View style={{ paddingBottom: 14, gap: 12 }}>
					<Text
						selectable
						style={{ color: colors.foregroundMuted, fontSize: 12 }}
					>
						{new Date(record.timestamp).toLocaleString()}
						{record.provider ? ` · ${record.provider}` : ""}
					</Text>
					<View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
						<Stat
							colors={colors}
							label="Input tokens"
							value={count(record.usage?.input)}
						/>
						<Stat
							colors={colors}
							label="Output tokens"
							value={count(record.usage?.output)}
						/>
						<Stat
							colors={colors}
							label="Cache read"
							value={count(record.usage?.cacheRead)}
						/>
						<Stat
							colors={colors}
							label="Cache write"
							value={count(record.usage?.cacheWrite)}
						/>
						{record.firstContentAt !== undefined ? (
							<Stat
								colors={colors}
								label="First content"
								value={duration(record.firstContentAt - record.timestamp)}
							/>
						) : null}
						{record.costSinceUser !== undefined ? (
							<Stat
								colors={colors}
								label="Since user · estimated"
								value={cost(record.costSinceUser)}
							/>
						) : null}
						{record.timeSinceUserMs !== undefined ? (
							<Stat
								colors={colors}
								label="Since user"
								value={duration(record.timeSinceUserMs)}
							/>
						) : null}
					</View>
				</View>
			) : null}
		</View>
	);
}
function ResponsesSection({ state, colors }: { state: State; colors: Colors }) {
	const [all, setAll] = useState(false),
		[toolsOpen, setToolsOpen] = useState(false);
	const data = state.data?.feature === "stamp" ? state.data.data : undefined;
	const records = data?.records.slice().reverse() ?? [];
	const responses = records.filter((r) => r.role === "assistant"),
		tools = records.filter((r) => r.role === "tool");
	return (
		<SettingsSection title="Recent responses">
			<SettingsCard>
				<View style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
					{!data ? (
						<View style={{ paddingVertical: 12 }}>
							<Message state={state} colors={colors} />
						</View>
					) : (
						<>
							{!responses.length ? (
								<Text
									style={{
										paddingVertical: 12,
										color: colors.foregroundMuted,
										fontSize: 13,
									}}
								>
									New response details appear here
								</Text>
							) : null}
							{(all ? responses : responses.slice(0, 5)).map((record) => (
								<ResponseRow key={record.id} record={record} colors={colors} />
							))}
							{responses.length > 5 ? (
								<Toggle
									colors={colors}
									expanded={all}
									label={
										all
											? "Show fewer responses"
											: `Show all ${responses.length} responses`
									}
									onPress={() => setAll(!all)}
								/>
							) : null}
							{tools.length ? (
								<Toggle
									colors={colors}
									expanded={toolsOpen}
									label={`Tool timing · ${tools.length}`}
									onPress={() => setToolsOpen(!toolsOpen)}
								/>
							) : null}
							{toolsOpen
								? tools.map((record) => (
										<View
											key={record.id}
											style={{
												flexDirection: "row",
												justifyContent: "space-between",
												gap: 12,
												paddingVertical: 8,
											}}
										>
											<Text
												numberOfLines={1}
												style={{
													flex: 1,
													color:
														record.outcome === "error"
															? colors.statusDanger
															: colors.foreground,
													fontSize: 13,
												}}
											>
												{record.tool}
												{record.outcome === "error" ? " · error" : ""}
											</Text>
											<Text
												style={{ color: colors.foregroundMuted, fontSize: 12 }}
											>
												{duration(
													record.completedAt === undefined
														? undefined
														: record.completedAt - record.timestamp,
												)}
											</Text>
										</View>
									))
								: null}
						</>
					)}
				</View>
			</SettingsCard>
		</SettingsSection>
	);
}
export function ObservabilityPanel({
	agentId,
	workspaceId,
	theme,
	host,
}: PluginAgentPanelProps) {
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
	const options = (feature: Feature) => ({
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
	const progress = useQuery(options("progress")),
		cache = useQuery(options("cache")),
		stamp = useQuery(options("stamp"));
	const state = (
		result: { data?: Snapshot; isError: boolean; isPending: boolean },
		feature: Feature,
	): State => ({
		data:
			ready &&
			!result.isError &&
			result.data?.sessionId === session &&
			result.data.feature === feature
				? result.data
				: undefined,
		pending: result.isPending,
		error: result.isError,
	});
	const colors = theme.colors;
	const refresh = () => {
		void identity.refetch();
		if (ready) {
			void progress.refetch();
			void cache.refetch();
			void stamp.refetch();
		}
	};
	return (
		<ScrollView
			style={{ flex: 1, backgroundColor: colors.surface0 }}
			contentContainerStyle={{ padding: 16, gap: 20 }}
		>
			<SectionHeading colors={colors} title="Activity">
				<Toggle colors={colors} label="Refresh" onPress={refresh} />
			</SectionHeading>
			{!ready ? (
				<SettingsCard>
					<View style={{ padding: 16 }}>
						<Text style={{ color: colors.foregroundMuted }}>
							{identity.isPending
								? "Connecting…"
								: "Reconnect to Pi and refresh Activity."}
						</Text>
					</View>
				</SettingsCard>
			) : (
				<View
					key={`${host.id}:${agentId}:${workspaceId}:${session}:${epoch}`}
					style={{ gap: 20 }}
				>
					<ProgressSection
						colors={colors}
						state={state(progress, "progress")}
					/>
					<CacheSection colors={colors} state={state(cache, "cache")} />
					<ResponsesSection colors={colors} state={state(stamp, "stamp")} />
				</View>
			)}
		</ScrollView>
	);
}
