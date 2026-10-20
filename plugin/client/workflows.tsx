import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import {
	SettingsSection,
	SettingsCard,
	SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import {
	useRpc,
	type PluginAgentPanelProps,
	type PluginClientContext,
	type PluginButtonRegistration,
} from "@getpaseo/plugin/client";
import {
	workflowsStatusRpc,
	workflowsControlRpc,
	type WorkflowRequest,
} from "../shared/workflows";

type Memory = {
	binding?: string;
	objective?: string;
	budget?: string;
	answers: Record<string, string>;
	pending: boolean;
	uncertain: boolean;
	error?: string;
	sequence: number;
	refreshed: number;
	failedAt: number;
};
const memories = new Map<string, Memory>();
const uuid = () =>
	"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === "x" ? r : (r & 3) | 8).toString(16);
	});
export function WorkflowsPanel(props: PluginAgentPanelProps) {
	return (
		<WorkflowsView
			key={JSON.stringify([props.host.id, props.workspaceId, props.agentId])}
			{...props}
		/>
	);
}
function WorkflowsView({
	host,
	agentId,
	workspaceId,
	theme,
	navigation,
}: PluginAgentPanelProps) {
	const status = useRpc(workflowsStatusRpc),
		control = useRpc(workflowsControlRpc);
	const [saved] = useState(() => {
		const key = JSON.stringify([host.id, agentId, workspaceId]);
		let value = memories.get(key);
		if (!value) {
			value = {
				answers: {},
				pending: false,
				uncertain: false,
				sequence: 0,
				refreshed: 0,
				failedAt: 0,
			};
			memories.set(key, value);
		}
		return value;
	});
	const [, update] = useState(0),
		mounted = useRef(true);
	const redraw = () => {
		if (mounted.current) update((n) => n + 1);
	};
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const query = useQuery({
		queryKey: ["pi-workflows", host.id, workspaceId, agentId],
		queryFn: async () => {
			const sequence = ++saved.sequence,
				result = await status({ agentId, workspaceId });
			if (result.available && result.snapshot) {
				const binding = JSON.stringify([
					result.sessionId,
					result.runtimeEpoch,
					result.snapshot.serviceEpoch,
				]);
				saved.binding ??= binding;
				if (saved.binding === binding)
					saved.refreshed = Math.max(saved.refreshed, sequence);
			}
			return result;
		},
		refetchInterval: (q) =>
			q.state.data?.snapshot?.busy ||
			q.state.data?.snapshot?.goal?.status === "active"
				? 1000
				: 5000,
		refetchOnReconnect: true,
		staleTime: 0,
	});
	const data = query.data,
		snapshot = data?.snapshot;
	const binding =
		data?.available && snapshot
			? JSON.stringify([
					data.sessionId,
					data.runtimeEpoch,
					snapshot.serviceEpoch,
				])
			: undefined;
	const current = !!binding && binding === saved.binding && !query.isError;
	const locked = !current || saved.pending || saved.uncertain;
	const goal = snapshot?.goal,
		dialog = snapshot?.dialog;
	const objective = saved.objective ?? goal?.text ?? "",
		budgetText = saved.budget ?? String(goal?.tokenBudget ?? 250000),
		budget = Number(budgetText);
	const validObjective =
		!!objective.trim() &&
		objective.length <= 4000 &&
		Number.isSafeInteger(budget) &&
		budget > 0 &&
		budget <= 1000000;
	const colors = theme.colors;
	const button = (label: string, onPress: () => void, disabled = false) => (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ disabled }}
			onPress={onPress}
			disabled={disabled}
			style={{
				minHeight: 44,
				justifyContent: "center",
				opacity: disabled ? 0.5 : 1,
			}}
		>
			<Text style={{ color: colors.accent }}>{label}</Text>
		</Pressable>
	);
	async function post(fields: Record<string, unknown>) {
		if (
			locked ||
			saved.pending ||
			saved.uncertain ||
			!snapshot ||
			!data?.runtimeEpoch ||
			!data.sessionId
		)
			return;
		saved.pending = true;
		saved.error = undefined;
		redraw();
		try {
			const result = await control({
				agentId,
				workspaceId,
				expectedRuntimeEpoch: data.runtimeEpoch,
				request: {
					sessionId: data.sessionId,
					serviceEpoch: snapshot.serviceEpoch,
					requestId: uuid(),
					...fields,
				} as WorkflowRequest,
			});
			await query.refetch();
			if (
				result.openedWorkspaceId &&
				mounted.current &&
				saved.binding === binding
			)
				navigation?.openWorkspace({
					workspaceId: result.openedWorkspaceId,
					serverId: host.id,
				});
		} catch {
			saved.uncertain = true;
			saved.failedAt = saved.sequence;
			saved.error =
				"The action may have completed. Refresh and review the current state before another action.";
		} finally {
			saved.pending = false;
			redraw();
		}
	}
	const start = (action: string, extra: Record<string, unknown> = {}) =>
		void post({
			operation: "start",
			action,
			expectedGoalId: goal?.id ?? null,
			...extra,
		});
	return (
		<ScrollView
			style={{ flex: 1, backgroundColor: colors.surface0 }}
			contentContainerStyle={{ padding: 16, gap: 16 }}
		>
			<View
				style={{
					flexDirection: "row",
					justifyContent: "space-between",
					alignItems: "center",
				}}
			>
				<Text
					accessibilityRole="header"
					style={{ color: colors.foreground, fontSize: 20, fontWeight: "600" }}
				>
					Workflows
				</Text>
				{button("Refresh", () => void query.refetch(), query.isFetching)}
			</View>
			{query.isPending ? (
				<Text style={{ color: colors.foregroundMuted }}>Connecting to Pi…</Text>
			) : null}
			{query.isError ? (
				<Text style={{ color: colors.statusWarning }}>
					Workflow connection unavailable. Refresh to reconnect.
				</Text>
			) : null}
			{!query.isPending && !query.isError && !data?.available ? (
				<Text style={{ color: colors.foregroundMuted }}>
					Reload Pi to enable Worktree and Goal, then refresh.
				</Text>
			) : null}
			{binding && saved.binding !== binding ? (
				<View>
					<Text style={{ color: colors.statusWarning }}>
						The Pi connection changed. Review the current session before
						continuing.
					</Text>
					{button(
						"Connect current session",
						() => {
							saved.binding = binding;
							saved.uncertain = false;
							saved.error = undefined;
							saved.answers = {};
							redraw();
							void query.refetch();
						},
						saved.pending,
					)}
				</View>
			) : null}
			{current && snapshot ? (
				<>
					<Text
						selectable
						style={{ color: colors.foregroundMuted, fontSize: 12 }}
					>
						{snapshot.cwd}
					</Text>
					{saved.error ? (
						<Text
							accessibilityRole="alert"
							style={{ color: colors.statusWarning }}
						>
							{saved.error}
						</Text>
					) : null}
					{saved.uncertain
						? button(
								"I reviewed the refreshed status",
								() => {
									saved.uncertain = false;
									saved.error = undefined;
									redraw();
								},
								saved.pending ||
									saved.refreshed <= saved.failedAt ||
									query.isFetching,
							)
						: null}
					{snapshot.notice ? (
						<Text
							selectable
							accessibilityRole="alert"
							style={{ color: colors.foregroundMuted }}
						>
							{snapshot.notice}
						</Text>
					) : null}
					{dialog ? (
						<SettingsSection title={dialog.title}>
							<SettingsCard>
								<View style={{ padding: 12, gap: 12 }}>
									{dialog.message ? (
										<Text selectable style={{ color: colors.foreground }}>
											{dialog.message}
										</Text>
									) : null}
									{dialog.kind === "input" ? (
										<TextInput
											accessibilityLabel={dialog.title}
											value={saved.answers[dialog.id] ?? ""}
											maxLength={8000}
											onChangeText={(value) => {
												saved.answers[dialog.id] = value;
												redraw();
											}}
											editable={!locked}
											style={{
												color: colors.foreground,
												backgroundColor: colors.surface2,
												padding: 12,
												borderRadius: 8,
												minHeight: 44,
											}}
										/>
									) : null}
									{dialog.kind === "select" ? (
										<SettingsSelect
											label="Selection"
											value={saved.answers[dialog.id] ?? ""}
											options={[
												{ label: "Choose…", value: "" },
												...dialog.options.map((value) => ({
													label: value,
													value,
												})),
											]}
											onValueChange={(value) => {
												saved.answers[dialog.id] = value;
												redraw();
											}}
											disabled={locked}
										/>
									) : null}
									{button(
										dialog.kind === "confirm" ? "Confirm" : "Continue",
										() =>
											void post({
												operation: "send",
												operationId: dialog.operationId,
												dialogId: dialog.id,
												value:
													dialog.kind === "confirm"
														? true
														: (saved.answers[dialog.id] ?? ""),
											}),
										locked ||
											(dialog.kind === "select" &&
												!dialog.options.includes(
													saved.answers[dialog.id] ?? "",
												)),
									)}
									{button(
										"Cancel operation",
										() =>
											void post({
												operation: "cancel",
												operationId: dialog.operationId,
											}),
										locked,
									)}
								</View>
							</SettingsCard>
						</SettingsSection>
					) : snapshot.busy ? (
						<View>
							<Text style={{ color: colors.foregroundMuted }}>
								Applying workflow operation…
							</Text>
							{snapshot.operationId
								? button(
										"Cancel operation",
										() =>
											void post({
												operation: "cancel",
												operationId: snapshot.operationId,
											}),
										locked,
									)
								: null}
						</View>
					) : null}
					<SettingsSection title="Goal">
						<SettingsCard>
							<View style={{ padding: 12, gap: 12 }}>
								{!goal && snapshot.lastCompletion ? (
									<View style={{ gap: 8 }}>
										<Text
											style={{ color: colors.statusSuccess, fontWeight: "600" }}
										>
											Last goal completed
										</Text>
										<Text selectable style={{ color: colors.foreground }}>
											{snapshot.lastCompletion.text}
										</Text>
										{snapshot.lastCompletion.summary ? (
											<Text
												selectable
												style={{ color: colors.foregroundMuted }}
											>
												{snapshot.lastCompletion.summary}
											</Text>
										) : null}
									</View>
								) : null}
								<Text style={{ color: colors.foreground, fontWeight: "600" }}>
									{goal
										? `${goal.status.replaceAll("_", " ")}${goal.waiting ? " · waiting" : ""}`
										: "Off"}
								</Text>
								{goal ? (
									<>
										<Text selectable style={{ color: colors.foreground }}>
											{goal.text}
										</Text>
										<Text style={{ color: colors.foregroundMuted }}>
											Automatic responses {goal.automaticTurns}/
											{snapshot.limits.automaticTurns ?? "∞"} · Tokens{" "}
											{goal.tokensUsed.toLocaleString()}/
											{goal.tokenBudget?.toLocaleString() ?? "∞"}
										</Text>
										{goal.waiting ? (
											<Text style={{ color: colors.foregroundMuted }}>
												{goal.waiting}
											</Text>
										) : null}
										{goal.safetyPauseCause ? (
											<Text style={{ color: colors.statusWarning }}>
												{goal.safetyPauseCause.replaceAll("_", " ")}
											</Text>
										) : null}
										{goal.summary ? (
											<Text selectable style={{ color: colors.foreground }}>
												{goal.summary}
											</Text>
										) : null}
									</>
								) : null}
								<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
									{snapshot.model ?? "Select a Pi model"} ·{" "}
									{snapshot.limits.automaticTurns ?? "Unlimited"} automatic
									responses · {snapshot.limits.noProgressTurns ?? "Unlimited"}{" "}
									repeated no-progress runs
								</Text>
								<TextInput
									accessibilityLabel="Goal objective"
									placeholder="Describe the outcome and how to verify it…"
									multiline
									maxLength={4000}
									value={objective}
									editable={!locked && !snapshot.busy}
									onChangeText={(value) => {
										saved.objective = value;
										redraw();
									}}
									style={{
										color: colors.foreground,
										backgroundColor: colors.surface2,
										padding: 12,
										borderRadius: 8,
										minHeight: 90,
									}}
								/>
								<Text style={{ color: colors.foregroundMuted }}>
									Total token budget (the last request may exceed it)
								</Text>
								<TextInput
									accessibilityLabel="Goal token budget"
									keyboardType="numeric"
									maxLength={7}
									value={budgetText}
									editable={!locked && !snapshot.busy}
									onChangeText={(value) => {
										saved.budget = value;
										redraw();
									}}
									style={{
										color: colors.foreground,
										backgroundColor: colors.surface2,
										padding: 12,
										borderRadius: 8,
										minHeight: 44,
									}}
								/>
								{button(
									!goal || goal.status === "complete"
										? "Start Goal"
										: "Update objective / budget",
									() =>
										start(
											!goal || goal.status === "complete"
												? "goal.start"
												: "goal.edit",
											{ objective: objective.trim(), tokenBudget: budget },
										),
									locked || snapshot.busy || !snapshot.idle || !validObjective,
								)}
								{goal?.status === "active"
									? button(
											"Pause Goal",
											() => start("goal.pause"),
											locked || snapshot.busy,
										)
									: null}
								{goal &&
								((goal.status !== "active" && goal.status !== "complete") ||
									goal.waiting)
									? button(
											goal.waiting ? "Wake Goal" : "Resume Goal",
											() => start("goal.resume"),
											locked || snapshot.busy || !snapshot.idle,
										)
									: null}
								{goal
									? button(
											"Clear Goal",
											() => start("goal.clear"),
											locked || snapshot.busy,
										)
									: null}
							</View>
						</SettingsCard>
					</SettingsSection>
					<SettingsSection title="Git worktrees">
						<SettingsCard>
							<View style={{ padding: 12, gap: 12 }}>
								{snapshot.worktreeLoading ? (
									<Text style={{ color: colors.foregroundMuted }}>
										Refreshing worktree inventory…
									</Text>
								) : null}
								{snapshot.worktreeError ? (
									<Text selectable style={{ color: colors.statusWarning }}>
										{snapshot.worktreeError}
									</Text>
								) : null}
								{snapshot.worktrees.map((tree) => (
									<View
										key={tree.path}
										style={{
											gap: 4,
											borderBottomWidth: 1,
											borderBottomColor: colors.border,
											paddingBottom: 8,
										}}
									>
										<Text
											style={{ color: colors.foreground, fontWeight: "600" }}
										>
											{tree.branch ?? "Detached HEAD"}
											{tree.current ? " · current" : tree.main ? " · main" : ""}
											{tree.locked ? " · locked" : ""}
											{tree.stale ? " · stale" : ""}
										</Text>
										<Text
											selectable
											style={{ color: colors.foregroundMuted, fontSize: 12 }}
										>
											{tree.path}
										</Text>
										{tree.head ? (
											<Text
												selectable
												style={{ color: colors.foregroundMuted, fontSize: 12 }}
											>
												{tree.head}
											</Text>
										) : null}
										{navigation?.openWorkspace && !tree.stale
											? button(
													"Open new workspace",
													() => start("worktree.open", { path: tree.path }),
													locked || snapshot.busy,
												)
											: null}
									</View>
								))}
								{button(
									"Create worktree",
									() => start("worktree.add"),
									locked ||
										snapshot.busy ||
										!snapshot.idle ||
										goal?.status === "active" ||
										!!snapshot.worktreeError,
								)}
								{button(
									"Remove linked worktree",
									() => start("worktree.remove"),
									locked ||
										snapshot.busy ||
										!snapshot.idle ||
										goal?.status === "active" ||
										!!snapshot.worktreeError,
								)}
								{button(
									"Prune stale metadata",
									() => start("worktree.prune"),
									locked ||
										snapshot.busy ||
										!snapshot.idle ||
										goal?.status === "active" ||
										!!snapshot.worktreeError,
								)}
								<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
									Changes require an exact preview and confirmation. Opening a
									workspace keeps this Pi conversation in place.
								</Text>
							</View>
						</SettingsCard>
					</SettingsSection>
				</>
			) : null}
		</ScrollView>
	);
}

export function contributeWorkflows(client: PluginClientContext) {
	const entries = new Map<
		string,
		{ workspace: string; button: PluginButtonRegistration }
	>();
	const lifetime = new AbortController();
	let stopped = false;
	const dispose = client.addWorkspacePanel({
		id: "pi-workflows",
		title: "Workflows",
		icon: "Workflow",
		context: "agent",
		locations: ["workspace"],
		Component: WorkflowsPanel,
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
				id: "pi-workflows",
				agentId: agent.id,
				workspaceId,
				button: {
					label: "Workflows",
					title: "Worktree and Goal",
					icon: "Workflow",
					behavior: {
						kind: "action",
						onPress: () =>
							client.openPanel("pi-workflows", {
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
					if (stopped) return;
					const ids = new Set(agents.map(({ agent }) => agent.id));
					for (const id of entries.keys()) if (!ids.has(id)) remove(id);
					for (const { agent } of agents) register(agent);
				},
				update: (message) => {
					if (stopped || message.type !== "agent_update") return;
					if (message.payload.kind === "remove")
						remove(message.payload.agentId);
					else register(message.payload.agent);
				},
			});
		})
		.catch((error) => {
			if (!stopped) console.error("Workflow subscription unavailable", error);
		});
	return () => {
		stopped = true;
		lifetime.abort();
		for (const id of entries.keys()) remove(id);
		dispose();
	};
}
