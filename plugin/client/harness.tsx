import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import {
	useRpc,
	type PluginAgentPanelProps,
	type PluginButtonContentProps,
	type PluginButtonIconProps,
	type PluginClientContext,
	type PluginButtonRegistration,
} from "@getpaseo/plugin/client";
import {
	harnessStatusRpc,
	harnessJobsListRpc,
	harnessJobsOutputRpc,
	harnessSubagentsListRpc,
	harnessSubagentReportRpc,
} from "../shared/harness-readonly";

import { ForegroundTasksSection } from "./foreground-tasks";
import {
	WorktreesPanel,
	WorktreesSection,
	WorkflowsSection,
	WorkflowsPanel,
} from "./workflows";
import { foregroundTasksStatusRpc } from "../shared/foreground-tasks";
import { isActiveWorkStatus } from "../shared/work-display";
import { isDormantIndependentAgent } from "../shared/independent-state";
import { WorkStatusRing } from "./work-status-ring";
import {
	createAgentConversationTabs,
	type AgentConversationTarget,
} from "./agent-conversation";

type Kind = "jobs" | "subagents";
type Agent = {
	id: string;
	workspaceId?: string | null;
	provider?: string;
	archivedAt?: string | null;
};

/** Registration is local. Queries run only for a mounted button or open view. */
export function contributeHarness(client: PluginClientContext) {
	const entries = new Map<
		string,
		{ workspaceId: string; buttons: PluginButtonRegistration[] }
	>();
	const lifetime = new AbortController();
	let stopped = false;
	const conversations = createAgentConversationTabs(client);
	const panels = [
		client.addWorkspacePanel({
			id: "harness-jobs",
			title: "Background jobs",
			icon: "Terminal",
			context: "agent",
			locations: ["workspace"],
			Component: JobsPanel,
		}),
		client.addWorkspacePanel({
			id: "harness-subagents",
			title: "Subagents",
			icon: "Users",
			context: "agent",
			locations: ["workspace"],
			Component: SubagentsPanel,
		}),
		client.addWorkspacePanel({
			id: "pi-worktrees",
			title: "Worktrees",
			icon: "GitBranch",
			context: "agent",
			locations: ["workspace"],
			Component: WorktreesPanel,
		}),
		client.addWorkspacePanel({
			id: "pi-workflows",
			title: "Goals",
			icon: "Workflow",
			context: "agent",
			locations: ["workspace"],
			Component: WorkflowsPanel,
		}),
	];
	const remove = (id: string) => {
		entries.get(id)?.buttons.forEach((button) => button.remove());
		entries.delete(id);
	};
	const register = (agent: Agent) => {
		if (stopped) return;
		if (
			agent.provider !== "pi" ||
			agent.archivedAt ||
			!agent.workspaceId ||
			isDormantIndependentAgent(agent)
		) {
			remove(agent.id);
			return;
		}
		if (entries.get(agent.id)?.workspaceId === agent.workspaceId) return;
		remove(agent.id);
		const workspaceId = agent.workspaceId;
		const entry = { workspaceId, buttons: [] as PluginButtonRegistration[] };
		const report = (label: string) => {
			if (!stopped && entries.get(agent.id) === entry)
				entry.buttons[0]?.update({ label });
		};
		let width: number | undefined;
		const reportContent = (nextWidth: number | undefined) => {
			if (stopped || entries.get(agent.id) !== entry || width === nextWidth)
				return;
			width = nextWidth;
			// Presentation-only: changing the behavior would close the host popover.
			entry.buttons[0]?.update({ desktopPopoverWidth: nextWidth });
		};
		entry.buttons.push(
			client.addComposerPill({
				id: "work",
				workspaceId,
				agentId: agent.id,
				button: {
					title: "Work",
					label: "Work",
					icon: (props) => <WorkIndicator {...props} report={report} />,
					behavior: {
						kind: "popover",
						Content: (props) => (
							<WorkPopover
								{...props}
								reportContent={reportContent}
								openConversation={async (target) => {
									if (
										stopped ||
										entries.get(agent.id) !== entry ||
										target.agentId !== agent.id ||
										target.workspaceId !== workspaceId
									)
										throw new Error(
											"The source conversation is no longer selected.",
										);
									await conversations.open(target);
									if (!stopped && entries.get(agent.id) === entry)
										props.close();
								}}
								openWorkspace={(id) => {
									if (!stopped && entries.get(agent.id) === entry) {
										conversations.openWorkspace({
											workspaceId: id,
											serverId: props.host.id,
										});
										props.close();
									}
								}}
								openPanel={(kind) => {
									if (!stopped && entries.get(agent.id) === entry) {
										client.openPanel(
											kind === "goals"
												? "pi-workflows"
												: kind === "worktrees"
													? "pi-worktrees"
													: `harness-${kind}`,
											{ workspaceId, agentId: agent.id },
										);
										props.close();
									}
								}}
							/>
						),
					},
				},
			}),
		);
		entries.set(agent.id, entry);
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
					if (message.type !== "agent_update") return;
					if (message.payload.kind === "remove")
						remove(message.payload.agentId);
					else register(message.payload.agent);
				},
			});
		})
		.catch((error) => {
			if (!stopped)
				console.error("Read-only harness observation unavailable", error);
		});
	return () => {
		stopped = true;
		lifetime.abort();
		for (const id of entries.keys()) remove(id);
		panels.forEach((dispose) => dispose());
		conversations.dispose();
	};
}

function JobsPanel(props: PluginAgentPanelProps) {
	return <HarnessPanel {...props} kind="jobs" />;
}
function SubagentsPanel(props: PluginAgentPanelProps) {
	return <HarnessPanel {...props} kind="subagents" />;
}
type JobScope = { agentId: string; workspaceId: string; host: { id: string } };
function useWorkSummary({ agentId, workspaceId, host }: JobScope) {
	const statusCall = useRpc(harnessStatusRpc),
		jobsCall = useRpc(harnessJobsListRpc),
		agentsCall = useRpc(harnessSubagentsListRpc),
		foregroundCall = useRpc(foregroundTasksStatusRpc);
	const target = { agentId, workspaceId };
	const identity = useQuery({
		queryKey: ["harness-status", agentId, workspaceId, host.id],
		queryFn: () => statusCall(target),
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
	const bound = {
		...target,
		expectedSessionId: session!,
		expectedRuntimeEpoch: epoch!,
	};
	const jobs = useQuery({
		queryKey: [
			"harness-list",
			"jobs",
			agentId,
			workspaceId,
			session,
			epoch,
			host.id,
		],
		enabled: ready,
		queryFn: () => jobsCall({ ...bound, limit: 50 }),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const agents = useQuery({
		queryKey: [
			"harness-list",
			"subagents",
			agentId,
			workspaceId,
			session,
			epoch,
			host.id,
		],
		enabled: ready,
		queryFn: () => agentsCall({ ...bound, limit: 50 }),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const foreground = useQuery({
		queryKey: ["foreground-tasks", host.id, agentId, workspaceId],
		queryFn: () => foregroundCall(target),
		refetchInterval: 2000,
		refetchOnReconnect: true,
		staleTime: 1000,
	});
	const foregroundRows =
		!foreground.isError && foreground.data?.available
			? foreground.data.tasks
			: undefined;
	const foregroundIds = new Set(foregroundRows?.map((row) => row.taskId));
	const count = (
		rows: readonly { status: string; needsAttention?: boolean }[] | undefined,
	) => {
		const active = rows?.filter((row) => isActiveWorkStatus(row.status)) ?? [];
		return {
			available: rows !== undefined,
			total: rows?.length ?? 0,
			active: active.length,
			attention: active.some(
				(row) => row.needsAttention || /waiting|blocked|needs/.test(row.status),
			),
		};
	};
	return {
		jobs: count(
			ready && !jobs.isError && jobs.data?.state === "available"
				? jobs.data.items
				: undefined,
		),
		foreground: count(foregroundRows),
		foregroundIds,
		agents: count(
			ready && !agents.isError && agents.data?.state === "available"
				? agents.data.items.filter(
						(row) =>
							row.kind !== "foreground" && !foregroundIds.has(row.taskId),
					)
				: undefined,
		),
	};
}
function WorkIndicator(
	props: PluginButtonIconProps & {
		report(label: string): void;
	},
) {
	if (props.context !== "agent") return null;
	return <MountedWorkIndicator {...props} />;
}
function MountedWorkIndicator(
	props: Extract<PluginButtonIconProps, { context: "agent" }> & {
		report(label: string): void;
	},
) {
	const summary = useWorkSummary(props);
	const agents = summary.agents.active,
		jobs = summary.jobs.active + summary.foreground.active;
	const count = agents || jobs;
	const attention = agents
		? summary.agents.attention
		: summary.jobs.attention || summary.foreground.attention;
	const label = agents
		? `${agents} ${agents === 1 ? "subagent" : "subagents"}`
		: jobs
			? `${jobs} ${jobs === 1 ? "job" : "jobs"}`
			: "Work";
	useEffect(() => {
		props.report(label);
	}, [label, props.report]);
	return count ? (
		<WorkStatusRing
			attention={attention}
			foreground={props.theme.colors.foreground}
			platform={props.layout.platform}
		/>
	) : (
		<Icon name="Briefcase" size={props.size} color={props.color} />
	);
}
type WorkPanelKind = Kind | "worktrees" | "goals";
type WorkContentSize = { reportContent(width: number | undefined): void };
type CompletedView = { completed: boolean; toggleCompleted(): void };
function WorkPopover(
	props: PluginButtonContentProps &
		WorkContentSize & {
			openPanel(kind: WorkPanelKind): void;
			openConversation(target: AgentConversationTarget): Promise<void>;
			openWorkspace(id: string): void;
		},
) {
	if (props.context !== "agent") return <View />;
	return <WorkOverview {...props} />;
}
function WorkOverview(
	props: Extract<PluginButtonContentProps, { context: "agent" }> &
		WorkContentSize & {
			openPanel(kind: WorkPanelKind): void;
			openConversation(target: AgentConversationTarget): Promise<void>;
			openWorkspace(id: string): void;
		},
) {
	const summary = useWorkSummary(props);
	const [section, setSection] = useState<
		"jobs" | "agents" | "worktrees" | "goals"
	>(() =>
		summary.agents.active
			? "agents"
			: summary.jobs.active || summary.foreground.active
				? "jobs"
				: "goals",
	);
	const colors = props.theme.colors;
	const [completed, setCompleted] = useState(false);
	const jobs = completed
		? summary.jobs.total -
			summary.jobs.active +
			summary.foreground.total -
			summary.foreground.active
		: summary.jobs.active + summary.foreground.active;
	const agents = completed
		? summary.agents.total - summary.agents.active
		: summary.agents.active;
	const desktopWidth =
		section === "jobs" && jobs > 0
			? completed
				? 960
				: 880
			: section === "agents" && agents > 0
				? completed
					? 1120
					: 880
				: undefined;
	const width =
		props.layout.platform === "web" && !props.layout.compact
			? desktopWidth
			: undefined;
	// One owner prevents a departing tab's cleanup from overriding the new tab's width.
	useEffect(() => {
		props.reportContent(width);
	}, [width, props.reportContent]);
	useEffect(() => () => props.reportContent(undefined), [props.reportContent]);
	const completedView = {
		completed,
		toggleCompleted: () => setCompleted((value) => !value),
	};
	return (
		<View
			style={{
				width: "100%",
				minWidth: 280,
				maxWidth:
					props.layout.compact || props.layout.platform !== "web"
						? 520
						: undefined,
				gap: 8,
			}}
		>
			<View
				accessibilityRole="tablist"
				style={{ flexDirection: "row", gap: 4 }}
			>
				{(["jobs", "agents", "worktrees", "goals"] as const).map((value) => (
					<Pressable
						key={value}
						accessibilityRole="tab"
						accessibilityState={{ selected: section === value }}
						onPress={() => {
							setCompleted(false);
							setSection(value);
						}}
						style={{
							flex: 1,
							minWidth: 0,
							minHeight: 44,
							alignItems: "center",
							justifyContent: "center",
							paddingVertical: 10,
							paddingHorizontal: 4,
							borderBottomWidth: 2,
							borderBottomColor:
								section === value ? colors.foreground : "transparent",
						}}
					>
						<Text
							numberOfLines={1}
							style={{
								textAlign: "center",
								lineHeight: 20,
								color:
									section === value
										? colors.foreground
										: colors.foregroundMuted,
							}}
						>
							{value === "jobs"
								? "Jobs"
								: value === "agents"
									? "Agents"
									: value === "worktrees"
										? "Worktrees"
										: "Goals"}
						</Text>
					</Pressable>
				))}
			</View>
			{section === "jobs" ? (
				<JobsOverview {...props} {...completedView} />
			) : section === "agents" ? (
				<AgentsOverview {...props} {...completedView} />
			) : section === "worktrees" ? (
				<WorktreesSection {...props} onOpenWorkspace={props.openWorkspace} />
			) : (
				<WorkflowsSectionEmbed {...props} />
			)}
		</View>
	);
}
function WorkflowsSectionEmbed(
	props: Extract<PluginButtonContentProps, { context: "agent" }>,
) {
	return <WorkflowsSection {...props} />;
}

function JobsOverview(
	props: Extract<PluginButtonContentProps, { context: "agent" }> &
		CompletedView,
) {
	const { completed } = props;
	const summary = useWorkSummary(props);
	const mode = completed ? "completed" : "active";
	const foreground = completed
		? summary.foreground.total - summary.foreground.active
		: summary.foreground.active;
	const background = completed
		? summary.jobs.total - summary.jobs.active
		: summary.jobs.active;
	const available = summary.foreground.available && summary.jobs.available;
	const colors = props.theme.colors;
	const empty = !foreground && !background;

	const emptyLabel = available
		? completed
			? "No completed jobs"
			: "No active jobs"
		: "Loading job status…";
	return (
		<View style={{ width: "100%", gap: empty ? 0 : 8 }}>
			{foreground > 0 ? (
				<ForegroundTasksSection
					key={`foreground-${mode}`}
					{...props}
					viewMode={mode}
				/>
			) : null}
			{background > 0 ? (
				<HarnessPanel
					key={`background-${mode}`}
					{...props}
					kind="jobs"
					viewMode={mode}
					embedded
				/>
			) : null}
			{completed ? (
				empty ? (
					<Text style={{ color: colors.foregroundMuted, padding: 12 }}>
						{emptyLabel}
					</Text>
				) : null
			) : (
				<SettingsAction
					label={empty ? emptyLabel : ""}
					actionLabel="Completed"
					onPress={props.toggleCompleted}
				/>
			)}
		</View>
	);
}

function AgentsOverview(
	props: Extract<PluginButtonContentProps, { context: "agent" }> &
		CompletedView & {
			openConversation(target: AgentConversationTarget): Promise<void>;
		},
) {
	const { completed } = props;
	const summary = useWorkSummary(props);
	const count = completed
		? summary.agents.total - summary.agents.active
		: summary.agents.active;

	const mode = completed ? "completed" : "active";
	const emptyLabel = summary.agents.available
		? completed
			? "No completed agents"
			: "No active agents"
		: "Loading agent status…";
	return (
		<View style={{ width: "100%", gap: count ? 8 : 0 }}>
			{count > 0 ? (
				<HarnessPanel
					key={mode}
					{...props}
					kind="subagents"
					viewMode={mode}
					excludeTaskIds={summary.foregroundIds}
					openConversation={props.openConversation}
					embedded
				/>
			) : null}
			{completed ? (
				!count ? (
					<Text
						style={{ color: props.theme.colors.foregroundMuted, padding: 12 }}
					>
						{emptyLabel}
					</Text>
				) : null
			) : (
				<SettingsAction
					label={count ? "" : emptyLabel}
					actionLabel="Completed"
					onPress={props.toggleCompleted}
				/>
			)}
		</View>
	);
}

function elapsed(start: string, end?: string | null) {
	const milliseconds = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
	if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
	const seconds = Math.floor(milliseconds / 1000);
	return seconds < 60
		? `${seconds}s`
		: seconds < 3600
			? `${Math.floor(seconds / 60)}m`
			: `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

function HarnessPanel({
	kind,
	agentId,
	workspaceId,
	theme,
	layout,
	navigation,
	host,
	embedded = false,
	viewMode = "all",
	excludeTaskIds,
	openConversation,
}: Omit<PluginAgentPanelProps, "navigation"> & {
	navigation?: PluginAgentPanelProps["navigation"];
	kind: Kind;
	embedded?: boolean;
	viewMode?: "all" | "active" | "completed";
	excludeTaskIds?: ReadonlySet<string>;
	openConversation?: (target: AgentConversationTarget) => Promise<void>;
}) {
	const statusCall = useRpc(harnessStatusRpc);
	const jobsCall = useRpc(harnessJobsListRpc);
	const tasksCall = useRpc(harnessSubagentsListRpc);
	const outputCall = useRpc(harnessJobsOutputRpc);
	const reportCall = useRpc(harnessSubagentReportRpc);
	const [selected, select] = useState<{
		id: string;
		session: string;
		epoch: string;
	} | null>(null);
	const opening = useRef(false),
		mounted = useRef(true);
	const [openingId, setOpeningId] = useState<string>();
	const [openError, setOpenError] = useState<string>();
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const target = { agentId, workspaceId };
	const identity = useQuery({
		queryKey: ["harness-status", agentId, workspaceId, host.id],
		queryFn: () => statusCall(target),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const session = identity.data?.sessionId;
	const epoch = identity.data?.runtimeEpoch;
	const ready =
		identity.data?.available === true &&
		!!session &&
		!!epoch &&
		!identity.isError;
	const bound = {
		...target,
		expectedSessionId: session!,
		expectedRuntimeEpoch: epoch!,
	};
	const list = useQuery({
		queryKey: [
			"harness-list",
			kind,
			agentId,
			workspaceId,
			session,
			epoch,
			host.id,
		],
		enabled: ready,
		queryFn: () =>
			kind === "jobs"
				? jobsCall({ ...bound, limit: 50 })
				: tasksCall({ ...bound, limit: 50 }),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const selectedId =
		selected &&
		selected.session === session &&
		selected.epoch === epoch &&
		(viewMode === "all" ||
			list.data?.items.some(
				(row) =>
					("jobId" in row ? row.jobId : row.taskId) === selected.id &&
					isActiveWorkStatus(row.status) === (viewMode === "active"),
			))
			? selected.id
			: undefined;
	const detail = useQuery({
		queryKey: [
			"harness-detail",
			kind,
			agentId,
			workspaceId,
			session,
			epoch,
			selectedId,
			host.id,
		],
		enabled: ready && !!selectedId,
		queryFn: () =>
			kind === "jobs"
				? outputCall({ ...bound, jobId: selectedId!, maxBytes: 24000 })
				: reportCall({ ...bound, taskId: selectedId!, maxBytes: 24000 }),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const fg = theme.colors.foreground,
		muted = theme.colors.foregroundMuted,
		danger = theme.colors.statusDanger;
	const button = (
		label: string,
		onPress: () => void,
		disabled = false,
		brief = false,
	) => (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			disabled={disabled}
			onPress={onPress}
			style={{ padding: 10, opacity: disabled ? 0.5 : 1 }}
		>
			<Text numberOfLines={brief ? 1 : undefined} style={{ color: fg }}>
				{label}
			</Text>
		</Pressable>
	);
	const rows =
		ready && !list.isError && list.data?.state === "available"
			? list.data.items.filter(
					(row) =>
						(kind !== "subagents" ||
							!("kind" in row) ||
							row.kind !== "foreground") &&
						(!("taskId" in row) || !excludeTaskIds?.has(row.taskId)) &&
						(viewMode === "all" ||
							isActiveWorkStatus(row.status) === (viewMode === "active")),
				)
			: [];
	const item =
		ready && !detail.isError && detail.data?.state === "available"
			? detail.data.item
			: undefined;
	const taskLink =
		item && "paseoAgentId" in item ? item.paseoAgentId : undefined;
	const selectedDetail =
		selectedId && ready ? (
			<View style={{ gap: 8, padding: 10, paddingTop: 0 }}>
				{detail.isPending ? (
					<Text style={{ color: muted }}>Loading selected item…</Text>
				) : null}
				{detail.isError ? (
					<Text style={{ color: danger }}>
						Selected item unavailable. Retrying automatically.
					</Text>
				) : null}
				{!detail.isPending && !detail.isError && !item ? (
					<Text style={{ color: muted }}>
						{detail.data?.message ??
							"No retained output or report is available."}
					</Text>
				) : null}
				{item ? (
					<>
						{item.truncated ? (
							<Text style={{ color: muted }}>Output truncated</Text>
						) : null}
						<View
							style={{
								borderWidth: 1,
								borderColor: theme.colors.border,
								borderRadius: 8,
								backgroundColor: theme.colors.surface0,
								padding: 12,
							}}
						>
							<Text
								selectable
								style={{
									color: fg,
									fontFamily:
										kind === "jobs"
											? layout.platform === "ios"
												? "Menlo"
												: "monospace"
											: undefined,
									fontSize: kind === "jobs" ? 12 : undefined,
									lineHeight: kind === "jobs" ? 18 : undefined,
								}}
							>
								{item.text || "No output or answer recorded yet."}
							</Text>
						</View>
					</>
				) : null}
				{taskLink && navigation?.openAgent
					? button("Open child chat", () =>
							navigation.openAgent({ agentId: taskLink, serverId: host.id }),
						)
					: null}
			</View>
		) : null;
	const content = (
		<View
			style={{
				paddingHorizontal:
					embedded && (kind === "subagents" || viewMode === "completed")
						? 4
						: 16,
				paddingVertical:
					embedded && viewMode === "completed"
						? 0
						: embedded && kind === "subagents"
							? 4
							: 16,
				gap: viewMode === "completed" ? 8 : 6,
			}}
		>
			{!embedded || (kind === "jobs" && viewMode !== "completed") ? (
				<Text accessibilityRole="header" style={{ color: fg, fontSize: 18 }}>
					{kind === "jobs" ? "Background" : "Subagents"}
				</Text>
			) : null}
			{identity.isPending ? (
				<Text style={{ color: muted }}>Connecting to this Pi session…</Text>
			) : null}
			{identity.isError ? (
				<Text style={{ color: danger }}>
					Session status unavailable. Retrying automatically.
				</Text>
			) : null}
			{!identity.isPending && !identity.isError && !ready ? (
				<Text style={{ color: muted }}>
					{identity.data?.reason ??
						"Read-only harness data unavailable. The Pi extensions and bridge may need reloading."}
				</Text>
			) : null}
			{ready && list.isPending ? (
				<Text style={{ color: muted }}>Loading…</Text>
			) : null}
			{ready && list.isError ? (
				<Text style={{ color: danger }}>
					This view is unavailable. Retrying automatically.
				</Text>
			) : null}
			{ready && list.data?.state !== "available" ? (
				<Text style={{ color: muted }}>{list.data?.message}</Text>
			) : null}
			{ready && list.data?.state === "available" && !rows.length ? (
				<Text style={{ color: muted }}>
					No {kind === "jobs" ? "background jobs" : "native subagent tasks"} in
					this session.
				</Text>
			) : null}
			{rows.map((row) => {
				const id = "jobId" in row ? row.jobId : row.taskId;
				const label =
					"jobId" in row
						? `${row.name ?? row.jobId}${viewMode === "active" || row.status === "completed" ? "" : ` · ${row.status}`} · ${elapsed(row.createdAt, ["starting", "running"].includes(row.status) ? null : row.updatedAt)}${row.observationOnly ? " · observation only" : ""}`
						: `${row.title}${viewMode === "active" ? (row.needsAttention ? " · needs attention" : "") : row.status === "completed" ? "" : ` · ${row.status}`}`;
				return (
					<View
						key={"childId" in row ? row.childId : id}
						style={
							!isActiveWorkStatus(row.status)
								? {
										borderWidth: 1,
										borderColor:
											selectedId === id
												? theme.colors.foregroundMuted
												: theme.colors.border,
										borderRadius: 10,
										backgroundColor: theme.colors.surface1,
										overflow: "hidden",
										marginBottom: 0,
									}
								: undefined
						}
					>
						{button(
							label,
							() => {
								if (
									kind === "subagents" &&
									viewMode === "completed" &&
									"taskId" in row &&
									openConversation
								) {
									if (opening.current) return;
									opening.current = true;
									setOpeningId(row.childId);
									setOpenError(undefined);
									void openConversation({
										hostId: host.id,
										agentId,
										workspaceId,
										sessionId: session!,
										taskId: row.taskId,
										childId: row.childId,
										attempt: row.attempt,
										runtimeId: row.runtimeId,
										title: row.title,
									})
										.catch((error) => {
											if (mounted.current)
												setOpenError(
													error instanceof Error
														? error.message.slice(0, 300)
														: "Could not open the conversation.",
												);
										})
										.finally(() => {
											opening.current = false;
											if (mounted.current) setOpeningId(undefined);
										});
								} else
									select(
										selectedId === id
											? null
											: { id, session: session!, epoch: epoch! },
									);
							},
							!!openingId,
							viewMode !== "completed",
						)}
						{selectedId === id ? selectedDetail : null}
					</View>
				);
			})}
			{openingId ? (
				<Text style={{ color: muted }}>Opening conversation…</Text>
			) : null}
			{openError ? (
				<Text accessibilityRole="alert" style={{ color: danger }}>
					{openError}
				</Text>
			) : null}
		</View>
	);
	return embedded ? (
		content
	) : (
		<ScrollView style={{ flex: 1 }}>{content}</ScrollView>
	);
}
