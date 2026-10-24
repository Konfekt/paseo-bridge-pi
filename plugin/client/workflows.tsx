import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import {
	SettingsSection,
	SettingsCard,
	SettingsSelect,
	SettingsAction,
} from "@getpaseo/plugin/client/ui";
import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Metadata, NativeButton } from "./presentation";
import {
	workflowsStatusRpc,
	workflowsControlRpc,
	type WorkflowRequest,
} from "../shared/workflows";

type Memory = {
	binding?: string;
	answers: Record<string, string>;
	pending: boolean;
	uncertain: boolean;
	error?: string;
	sequence: number;
	showAllWorktrees: boolean;
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
			section="goal"
		/>
	);
}
export function WorkflowsSection(
	props: Omit<PluginAgentPanelProps, "navigation">,
) {
	return <WorkflowsView {...props} section="goal" embedded />;
}
export function WorktreesPanel(props: PluginAgentPanelProps) {
	return <WorkflowsView {...props} section="worktrees" />;
}
export function WorktreesSection(
	props: Omit<PluginAgentPanelProps, "navigation"> & {
		onOpenWorkspace?: (id: string) => void;
	},
) {
	return <WorkflowsView {...props} section="worktrees" embedded />;
}
type WorkflowViewProps = Omit<PluginAgentPanelProps, "navigation"> & {
	navigation?: PluginAgentPanelProps["navigation"];
	section: "goal" | "worktrees";
	embedded?: boolean;
	onOpenWorkspace?: (id: string) => void;
};
function WorkflowsView({
	host,
	agentId,
	workspaceId,
	theme,
	navigation,
	section,
	embedded = false,
	onOpenWorkspace,
}: WorkflowViewProps) {
	const [selectedTree, setSelectedTree] = useState<string>();
	const [editing, setEditing] = useState(false),
		[objective, setObjective] = useState(""),
		[budgetText, setBudgetText] = useState(""),
		[addingTask, setAddingTask] = useState(false),
		[taskText, setTaskText] = useState(""),
		[limitsOpen, setLimitsOpen] = useState(false),
		[completedOpen, setCompletedOpen] = useState(false);
	const status = useRpc(workflowsStatusRpc),
		control = useRpc(workflowsControlRpc);
	const [saved] = useState(() => {
		const key = JSON.stringify([host.id, agentId, workspaceId]);
		let item = memories.get(key);
		if (!item) {
			item = {
				answers: {},
				pending: false,
				uncertain: false,
				sequence: 0,
				showAllWorktrees: false,
				refreshed: 0,
				failedAt: 0,
			};
			memories.set(key, item);
		}
		return item;
	});
	const [, update] = useState(0),
		mounted = useRef(true),
		resetIdentity = useRef("");
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
				const next = JSON.stringify([
					result.sessionId,
					result.runtimeEpoch,
					result.snapshot.serviceEpoch,
				]);
				if (
					saved.binding &&
					saved.binding !== next &&
					!saved.pending &&
					!saved.uncertain &&
					!result.snapshot.operationId
				) {
					if (JSON.parse(saved.binding)[0] !== result.sessionId) {
						saved.answers = {};
						saved.showAllWorktrees = false;
					}
					saved.binding = next;
					saved.error = undefined;
				}
				saved.binding ??= next;
				if (saved.binding === next)
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
		snapshot = data?.snapshot,
		completedGoals = snapshot?.completedGoals ?? [],
		binding =
			data?.available && snapshot
				? JSON.stringify([
						data.sessionId,
						data.runtimeEpoch,
						snapshot.serviceEpoch,
					])
				: undefined;
	const current = !!binding && binding === saved.binding && !query.isError,
		locked = !current || saved.pending || saved.uncertain,
		goal = snapshot?.goal,
		dialog = snapshot?.dialog,
		colors = theme.colors,
		showAllWorktrees = saved.showAllWorktrees === true,
		visibleWorktrees = snapshot?.worktrees.filter(
			(tree) => showAllWorktrees || tree.createdInSession === true,
		) ?? [];
	const parsedBudget = budgetText.trim() ? Number(budgetText) : undefined;
	const validBudget = parsedBudget === undefined || (
		/^\d+$/.test(budgetText.trim()) && Number.isSafeInteger(parsedBudget) &&
		parsedBudget >= 1 && parsedBudget <= 1_000_000
	);
	const goalIdentity = `${binding ?? ""}/${goal?.id ?? "none"}`;
	useEffect(() => {
		if (resetIdentity.current && resetIdentity.current !== goalIdentity) {
			setEditing(false);
			setObjective("");
			setBudgetText("");
			setAddingTask(false);
			setTaskText("");
			setLimitsOpen(false);
		}
		resetIdentity.current = goalIdentity;
	}, [goalIdentity]);
	async function post(fields: Record<string, unknown>): Promise<boolean> {
		if (
			locked ||
			saved.pending ||
			saved.uncertain ||
			!snapshot ||
			!data?.runtimeEpoch ||
			!data.sessionId
		)
			return false;
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
			) {
				if (navigation?.openWorkspace)
					navigation.openWorkspace({
						workspaceId: result.openedWorkspaceId,
						serverId: host.id,
					});
				else onOpenWorkspace?.(result.openedWorkspaceId);
			}
			return true;
		} catch {
			saved.uncertain = true;
			saved.failedAt = saved.sequence;
			saved.error =
				"The action may have completed. Review the automatically updated state before another action.";
			return false;
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
	const button = (label: string, onPress: () => void, disabled = false) =>
		section === "goal"
			? <NativeButton colors={colors} label={label} onPress={onPress} disabled={disabled} style={{ alignSelf: "flex-start", minHeight: 44, maxWidth: "100%", flexShrink: 1 }} />
			: <NativeButton colors={colors} label={label} onPress={onPress} disabled={disabled} style={{ alignSelf: "flex-start", minHeight: 44 }} />;
	const Container = embedded ? View : ScrollView;
	const goalSection = (
		<View style={{ padding: 4, gap: 8, minWidth: 0 }}>
			{!goal ? (
				<>
					<TextInput
						accessibilityLabel="New goal"
						placeholder="Describe the goal…"
						placeholderTextColor={colors.foregroundMuted}
						value={objective}
						onChangeText={setObjective}
						editable={!locked && !snapshot?.busy}
						multiline
						maxLength={4000}
						style={{
							minHeight: 72,
							padding: 10,
							borderWidth: 1,
							borderColor: colors.border,
							borderRadius: 8,
							color: colors.foreground,
							backgroundColor: colors.surface2,
						}}
					/>
					<View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
						{button(
							"Create",
							() => {
								void post({
									operation: "start",
									action: "goal.create_paused",
									expectedGoalId: null,
									objective: objective.trim(),
									...(parsedBudget === undefined ? {} : { tokenBudget: parsedBudget }),
								});
							},
							locked ||
								!snapshot?.capabilities?.createPausedGoal ||
								!objective.trim() ||
								!!snapshot?.busy ||
								!snapshot?.idle ||
								!validBudget,
						)}
						<TextInput
							accessibilityLabel="New goal token budget"
							placeholder="Token budget · unlimited"
							placeholderTextColor={colors.foregroundMuted}
							value={budgetText}
							onChangeText={setBudgetText}
							keyboardType="numeric"
							editable={!locked && !snapshot?.busy}
							style={{
								minHeight: 44, minWidth: 160, flexGrow: 1, flexShrink: 1,
								paddingHorizontal: 10, borderWidth: 1,
								borderColor: colors.border, borderRadius: 8,
								color: colors.foreground, backgroundColor: colors.surface2,
							}}
						/>
					</View>
				</>
			) : (
				<>
					<Text selectable style={{ color: colors.foreground }}>
						{goal.text}
					</Text>
					<Text
						style={{
							color:
								goal.status === "blocked" || goal.status.endsWith("_limited")
									? colors.statusWarning
									: colors.foregroundMuted,
						}}
					>
						{goal.waiting
							? "Waiting"
							: {
									active: "Working",
									paused: "Paused",
									blocked: "Blocked",
									usage_limited: "Usage limit reached",
									budget_limited: "Budget reached",
									complete: "Complete",
								}[goal.status]}
					</Text>
					{goal.tasks?.map((task, index) => (
						<Text
							key={`${index}-${task.text}`}
							accessibilityLabel={`${task.text}, ${task.status.replaceAll("_", " ")}`}
							style={{
								color:
									task.status === "blocked"
										? colors.statusWarning
										: task.status === "in_progress"
											? colors.foreground
											: colors.foregroundMuted,
							}}
						>
							{
								{
									completed: "✓",
									in_progress: "›",
									blocked: "!",
									pending: "○",
								}[task.status]
							}{" "}
							{task.text}
						</Text>
					))}
					{goal.waiting ? (
						<Text style={{ color: colors.statusWarning }}>{goal.waiting}</Text>
					) : null}
					{goal.safetyPauseCause ? (
						<Text style={{ color: colors.statusWarning }}>
							{goal.safetyPauseCause === "continuation_limit"
								? "Automatic response limit reached"
								: "Paused after repeated lack of progress"}
						</Text>
					) : null}
					{goal.summary ? (
						<Text selectable style={{ color: colors.foregroundMuted }}>
							{goal.summary}
						</Text>
					) : null}
					<View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
						{goal.status === "active" && !goal.waiting
							? button(
									"Pause",
									() => start("goal.pause"),
									locked || snapshot?.busy,
								)
							: button(
									"Resume",
									() => start("goal.resume"),
									locked ||
										snapshot?.busy ||
										!snapshot?.idle ||
										goal.status === "complete",
								)}
						{button(
							"Edit",
							() => {
								setObjective(goal.text);
								setBudgetText(goal.tokenBudget === undefined || goal.tokenBudget === null ? "" : String(goal.tokenBudget));
								setEditing(!editing);
								setAddingTask(false);
							},
							locked || snapshot?.busy,
						)}
						{button(
							"Clear",
							() => start("goal.clear"),
							locked || snapshot?.busy,
						)}
						{button(limitsOpen ? "Hide limits" : "Limits", () =>
							setLimitsOpen(!limitsOpen),
						)}
					</View>
					{limitsOpen ? (
						<Text style={{ color: colors.foregroundMuted }}>
							Automatic responses: {goal.automaticTurns}/
							{snapshot?.limits.automaticTurns ?? "Unlimited"} · Tokens:{" "}
							{goal.tokensUsed.toLocaleString()}/
							{goal.tokenBudget?.toLocaleString() ?? "Unlimited"} · No-progress
							limit: {snapshot?.limits.noProgressTurns ?? "Unlimited"}
						</Text>
					) : null}
					{editing ? (
						<View style={{ gap: 6 }}>
							<TextInput
								accessibilityLabel="Goal objective"
								value={objective}
								onChangeText={setObjective}
								multiline
								maxLength={4000}
								style={{
									color: colors.foreground,
									backgroundColor: colors.surface2,
									padding: 12,
									minHeight: 80,
								}}
							/>
							<Text style={{ color: colors.foregroundMuted }}>
								Token budget
							</Text>
							<TextInput
								accessibilityLabel="Goal token budget"
								placeholder={goal.tokenBudget == null ? "Unlimited" : "Keep current budget"}
								placeholderTextColor={colors.foregroundMuted}
								value={budgetText}
								onChangeText={setBudgetText}
								keyboardType="numeric"
								maxLength={7}
								style={{
									color: colors.foreground,
									backgroundColor: colors.surface2,
									padding: 12,
								}}
							/>
							{button(
								"Save changes",
								() => {
									if (objective.trim() && validBudget) {
										void start("goal.edit", {
											objective: objective.trim(),
											...(parsedBudget === undefined ? {} : { tokenBudget: parsedBudget }),
										});
									}
								},
								locked ||
									snapshot?.busy ||
									!snapshot?.idle ||
									!objective.trim() ||
									!validBudget,
							)}
							{button("Cancel", () => setEditing(false), locked)}
						</View>
					) : null}
					{goal.status === "active" ? (
						<Text style={{ color: colors.foregroundMuted }}>
							Pause to add a task
						</Text>
					) : (
						<>
							<View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
								{button(
									addingTask ? "Cancel subtask" : "Add subtask",
									() => {
										setAddingTask(!addingTask);
										setTaskText("");
										setEditing(false);
									},
									locked || snapshot?.busy || !snapshot?.idle,
								)}
								{completedGoals.length > 0 ? button(
									completedOpen ? "Hide completed" : "Completed",
									() => setCompletedOpen((open) => !open),
								) : null}
							</View>
							{addingTask ? (
								<View style={{ gap: 6 }}>
									<TextInput
										accessibilityLabel="Subtask"
										value={taskText}
										onChangeText={setTaskText}
										placeholder="Describe a subtask"
										maxLength={503}
										style={{
											color: colors.foreground,
											backgroundColor: colors.surface2,
											padding: 12,
										}}
									/>
									{button(
										"Add task",
										() => {
											const text = taskText.trim();
											if (text) {
												const identity = goalIdentity;
												void post({
													operation: "start",
													action: "goal.add_task",
													expectedGoalId: goal.id,
													text,
												}).then((applied) => {
													if (
														applied &&
														mounted.current &&
														resetIdentity.current === identity
													) {
														setTaskText("");
														setAddingTask(false);
													}
												});
											}
										},
										locked ||
											snapshot?.busy ||
											!snapshot?.idle ||
											!taskText.trim(),
									)}
								</View>
							) : null}
						</>
					)}
				</>
			)}
		</View>
	);
	return (
		<Container
			{...(embedded
				? { style: { padding: 8, gap: 8, minWidth: 0 } }
				: {
						style: { flex: 1, backgroundColor: colors.surface0, minWidth: 0 },
						contentContainerStyle: { padding: 12, gap: 12 },
					})}
		>
			{query.isPending ? (
				<Metadata colors={colors}>Connecting to Pi…</Metadata>
			) : null}
			{query.isError ? (
				<Text style={{ color: colors.statusWarning }}>
					Workflow connection unavailable. Retrying automatically.
				</Text>
			) : null}
			{!query.isPending && !query.isError && !data?.available ? (
				<Metadata colors={colors}>
					Reload Pi to enable Worktree and Goal.
				</Metadata>
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
					{section === "goal" ? (
						<>
							{dialog || snapshot.busy ? null : goalSection}
							{completedGoals.length > 0 ? (
								<View style={{ gap: 8 }}>
									{!goal || goal.status === "active" || dialog || snapshot.busy ? button(
										completedOpen
											? "Hide completed"
											: "Completed",
										() => setCompletedOpen((open) => !open),
									) : null}
									{completedOpen ? (
										<SettingsCard>
											<View style={{ padding: 12, gap: 12 }}>
												{completedGoals.map((item) => (
													<View key={item.id} style={{ gap: 4 }}>
														<View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
															<Text style={{ color: item.status === "completed" ? colors.statusSuccess : colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
																{item.status === "completed" ? "Completed" : "Cleared"}
															</Text>
															{item.endedAt > 0 ? (
																<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
																	{new Date(item.endedAt).toLocaleDateString()}
																</Text>
															) : null}
														</View>
														<Text selectable style={{ color: colors.foreground }}>
															{item.text}
														</Text>
														{item.summary ? (
															<Text selectable style={{ color: colors.foregroundMuted }}>
																{item.summary}
															</Text>
														) : null}
														{item.tasks.length ? (
															<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
																{item.tasks.filter((task) => task.status === "completed").length}/{item.tasks.length} subtasks completed
															</Text>
														) : null}
													</View>
												))}
											</View>
										</SettingsCard>
									) : null}
								</View>
							) : null}
						</>
					) : (
						<View style={{ gap: 4 }}>
							{snapshot.worktreeLoading ? (
								<Text style={{ color: colors.foregroundMuted }}>
									Loading worktrees…
								</Text>
							) : null}
							{snapshot.worktreeError ? (
								<Text selectable style={{ color: colors.statusWarning }}>
									{snapshot.worktreeError}
								</Text>
							) : null}
								{!snapshot.worktreeLoading && !snapshot.worktreeError ? (
								<NativeButton
									colors={colors}
									label={saved.showAllWorktrees ? "Show ours" : "Show all"}
									onPress={() => {
										saved.showAllWorktrees = !saved.showAllWorktrees;
										redraw();
									}}
									style={{ alignSelf: "flex-start", minHeight: 32 }}
								/>
							) : null}
							{!snapshot.worktreeLoading &&
							!snapshot.worktreeError &&
							!visibleWorktrees.length ? (
								<Text style={{ color: colors.foregroundMuted, padding: 8 }}>
									{snapshot.worktreeContainer &&
									!snapshot.worktreeRepositoryCount
										? "No Git repositories found within two directory levels"
										: showAllWorktrees
											? "No additional worktrees"
											: "No session-created worktrees"}
								</Text>
							) : null}
							{visibleWorktrees.map((tree, index) => {
								const unsafe =
										tree.stale ||
										tree.locked ||
										tree.current ||
										tree.main ||
										tree.inUse === true ||
										tree.changedFiles == null ||
										tree.changedFiles > 0,
									guarded =
										locked ||
										snapshot.busy ||
										!snapshot.idle ||
										goal?.status === "active" ||
										unsafe,
									selected = selectedTree === tree.path;
								return (
									<View
										key={tree.path}
										style={{
											borderBottomWidth: 1,
											borderBottomColor: colors.border,
										}}
									>
										{tree.repositoryPath &&
										tree.repositoryPath !==
											visibleWorktrees[index - 1]?.repositoryPath ? (
											<Text
												accessibilityRole="header"
												style={{
													color: colors.foregroundMuted,
													fontWeight: "600",
													paddingHorizontal: 8,
													paddingTop: 12,
													paddingBottom: 4,
												}}
											>
												{tree.repositoryLabel ?? tree.repositoryPath}
											</Text>
										) : null}
										<Pressable
											accessibilityRole="button"
											accessibilityState={{ selected }}
											onPress={() =>
												setSelectedTree(selected ? undefined : tree.path)
											}
											style={({ pressed }) => ({
												minHeight: 44,
												justifyContent: "center",
												paddingHorizontal: 12,
												borderRadius: 8,
												backgroundColor: pressed || selected ? colors.surface2 : "transparent",
											})}
										>
											<Text
												numberOfLines={1}
												style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}
											>
												{tree.main
													? "Main checkout"
													: (tree.ownerTitle ??
														tree.branch ??
														"Detached worktree")}
											</Text>
											<Text
												numberOfLines={2}
												style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}
											>
												{tree.ownerTitle || tree.main
													? `${tree.branch ?? "Detached"} · `
													: ""}
												{tree.changedFiles == null
													? "Status unavailable"
													: tree.changedFiles
														? `${tree.changedFiles} changed`
														: "Clean"}
												{tree.inUse ? " · worker attached" : ""}
												{tree.current ? " · current" : ""}
												{tree.locked ? " · locked" : ""}
												{tree.stale ? " · stale" : ""}
											</Text>
										</Pressable>
										{selected ? (
											<View style={{ padding: 8, gap: 4 }}>
												<Text
													selectable
													style={{ color: colors.foregroundMuted }}
												>
													{tree.path}
												</Text>
												{tree.includedChanges ? (
													<Text style={{ color: colors.foregroundMuted }}>
														Includes parent changes
													</Text>
												) : null}
												{tree.setupError ? (
													<Text style={{ color: colors.statusWarning }}>
														{tree.setupError}
													</Text>
												) : null}
												{guarded ? (
													<Text style={{ color: colors.foregroundMuted }}>
														{tree.inUse
															? "Reap the worker before removal"
															: tree.current
																? "Current worktree cannot be removed"
																: tree.locked
																	? "Worktree is locked"
																	: tree.stale
																		? "Stale worktree metadata"
																		: tree.changedFiles == null
																			? "Change status unavailable"
																			: tree.changedFiles > 0
																				? "Uncommitted changes must be preserved"
																				: "Wait until Pi and Goal are idle"}
													</Text>
												) : null}
												<View style={{ flexDirection: "row", gap: 12 }}>
													{onOpenWorkspace || navigation?.openWorkspace ? (
														<SettingsAction
															label=""
															actionLabel="Open"
															disabled={locked || snapshot.busy || tree.stale}
															onPress={() =>
																start("worktree.open", { path: tree.path })
															}
														/>
													) : null}
													<SettingsAction
														label=""
														actionLabel="Remove"
														disabled={guarded}
														onPress={() =>
															start("worktree.remove", { path: tree.path })
														}
													/>
												</View>
											</View>
										) : null}
									</View>
								);
							})}
						</View>
					)}
				</>
			) : null}
		</Container>
	);
}
/** Compatibility export retained; the Goals tab in Work is the primary entry. */
export function contributeWorkflows(
	_client: import("@getpaseo/plugin/client").PluginClientContext,
) {
	return () => {};
}
