import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
	ScrollView,
	TextInput,
	copyText,
} from "@getpaseo/plugin/client/react-native";
import {
	SettingsCard,
	SettingsSection,
	SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import {
	useRpc,
	type PluginAgentPanelProps,
	type PluginClientContext,
	type PluginButtonRegistration,
} from "@getpaseo/plugin/client";
import { btwControlRpc, btwStatusRpc, type BtwRequest } from "../shared/btw";

type Memory = {
	selected?: string;
	model?: string;
	context: "recent" | "none";
	binding?: string;
	deleteConfirm?: string;
	drafts: Record<string, { text: string; revision: number }>;
	busy: boolean;
	uncertain: boolean;
	message?: string;
	sequence: number;
	refreshed: number;
	failedAt: number;
};
const memories = new Map<string, Memory>();
function memory(key: string): Memory {
	let m = memories.get(key);
	if (!m) {
		m = {
			context: "recent",
			drafts: {},
			busy: false,
			uncertain: false,
			sequence: 0,
			refreshed: 0,
			failedAt: 0,
		};
		memories.set(key, m);
	}
	return m;
}
function uuid() {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === "x" ? r : (r & 3) | 8).toString(16);
	});
}

export function BtwPanel(props: PluginAgentPanelProps) {
	return (
		<BtwView
			key={JSON.stringify([props.host.id, props.workspaceId, props.agentId])}
			{...props}
		/>
	);
}
function BtwView({ host, workspaceId, agentId, theme }: PluginAgentPanelProps) {
	const status = useRpc(btwStatusRpc),
		control = useRpc(btwControlRpc);
	const [saved] = useState(() =>
		memory(JSON.stringify([host.id, workspaceId, agentId])),
	);
	const [, redraw] = useState(0);
	const refreshView = () => redraw((n) => n + 1);
	const selected = saved.selected;
	const query = useQuery({
		queryKey: ["pi-btw", host.id, workspaceId, agentId, selected ?? ""],
		queryFn: async () => {
			const sequence = ++saved.sequence;
			const data = await status({
				agentId,
				workspaceId,
				...(selected ? { threadId: selected } : {}),
			});
			if (data.available && data.snapshot) {
				const binding = JSON.stringify([
					data.sessionId,
					data.runtimeEpoch,
					data.snapshot.serviceEpoch,
				]);
				saved.binding ??= binding;
				if (binding === saved.binding)
					saved.refreshed = Math.max(saved.refreshed, sequence);
			}
			return data;
		},
		refetchInterval: (query) =>
			query.state.data?.snapshot?.threads.find((t) => t.id === selected)
				?.state === "running"
				? 1000
				: 5000,
		refetchOnReconnect: true,
		staleTime: 0,
	});
	const data = query.data,
		snap = data?.snapshot;
	const binding =
		data?.available && snap
			? JSON.stringify([data.sessionId, data.runtimeEpoch, snap.serviceEpoch])
			: undefined;
	const current = !!binding && binding === saved.binding && !query.isError;
	const thread = current
		? snap?.threads.find((t) => t.id === selected)
		: undefined;
	const draftKey = selected ?? "new",
		draft = saved.drafts[draftKey]?.text ?? "";
	const blocked = !current || saved.busy || saved.uncertain;
	const colors = theme.colors;
	const button = (label: string, action: () => void, disabled = false) => (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ disabled }}
			disabled={disabled}
			onPress={action}
			style={{
				minHeight: 44,
				justifyContent: "center",
				opacity: disabled ? 0.5 : 1,
			}}
		>
			<Text style={{ color: colors.accent }}>{label}</Text>
		</Pressable>
	);
	async function mutate(operation: BtwRequest["operation"]) {
		if (
			blocked ||
			saved.busy ||
			saved.uncertain ||
			!snap ||
			!data?.runtimeEpoch ||
			!data.sessionId
		)
			return;
		const question = draft.trim(),
			submitted = saved.drafts[draftKey];
		if (
			(operation === "start" || operation === "send") &&
			(!question || thread?.state === "running")
		)
			return;
		const threadId = operation === "start" ? uuid() : selected;
		if (!threadId) return;
		const base = {
			sessionId: data.sessionId,
			serviceEpoch: snap.serviceEpoch,
			requestId: uuid(),
			threadId,
		};
		const request: BtwRequest =
			operation === "start"
				? {
						...base,
						operation,
						question,
						model: saved.model ?? snap.defaultModel,
						context: saved.context,
					}
				: operation === "send"
					? { ...base, operation, question }
					: { ...base, operation };
		saved.busy = true;
		saved.message = undefined;
		if (operation === "start") saved.selected = threadId;
		refreshView();
		try {
			await control({
				agentId,
				workspaceId,
				expectedRuntimeEpoch: data.runtimeEpoch,
				request,
			});
			if (
				(operation === "start" || operation === "send") &&
				submitted &&
				saved.drafts[draftKey]?.revision === submitted.revision
			)
				saved.drafts[draftKey] = { text: "", revision: submitted.revision + 1 };
			if (operation === "remove" && saved.selected === threadId)
				saved.selected = undefined;
		} catch {
			saved.uncertain = true;
			saved.failedAt = saved.sequence;
			saved.message =
				"The action may have completed. Refresh and review this thread before another action.";
		} finally {
			saved.busy = false;
			refreshView();
			void query.refetch();
		}
	}
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
					BTW
				</Text>
				{button("Refresh", () => void query.refetch(), query.isFetching)}
			</View>
			{query.isPending ? (
				<Text style={{ color: colors.foregroundMuted }}>Connecting to Pi…</Text>
			) : null}
			{query.isError ? (
				<Text style={{ color: colors.statusWarning }}>
					BTW connection unavailable. Refresh to reconnect.
				</Text>
			) : null}
			{!query.isPending && !query.isError && !data?.available ? (
				<Text style={{ color: colors.foregroundMuted }}>
					Reload Pi to enable BTW, then refresh.
				</Text>
			) : null}
			{binding && binding !== saved.binding ? (
				<View>
					<Text style={{ color: colors.statusWarning }}>
						The Pi connection changed. Review the current session before
						continuing.
					</Text>
					{button(
						"Connect current session",
						() => {
							saved.binding = binding;
							saved.selected = undefined;
							saved.uncertain = false;
							saved.message = undefined;
							refreshView();
							void query.refetch();
						},
						saved.busy,
					)}
				</View>
			) : null}
			{current && snap ? (
				<>
					<SettingsSection title="Side conversations">
						<SettingsCard>
							<SettingsSelect
								label="Conversation"
								value={selected ?? "new"}
								options={[
									{ label: "New conversation", value: "new" },
									...snap.threads.map((t) => ({
										label: `${t.question.slice(0, 70)} · ${t.state}`,
										value: t.id,
									})),
								]}
								onValueChange={(value) => {
									saved.selected = value === "new" ? undefined : value;
									saved.deleteConfirm = undefined;
									if (!saved.uncertain) saved.message = undefined;
									refreshView();
								}}
								disabled={saved.busy}
							/>
							{!selected ? (
								<>
									<SettingsSelect
										label="Model"
										value={saved.model ?? snap.defaultModel}
										options={[
											...new Set([snap.defaultModel, ...snap.models]),
										].map((value) => ({ label: value, value }))}
										onValueChange={(value) => {
											saved.model = value;
											refreshView();
										}}
										disabled={blocked}
									/>
									<SettingsSelect
										label="Context"
										value={saved.context}
										options={[
											{ label: "Recent main conversation", value: "recent" },
											{ label: "No main context", value: "none" },
										]}
										onValueChange={(value) => {
											saved.context = value;
											refreshView();
										}}
										disabled={blocked}
									/>
								</>
							) : null}
						</SettingsCard>
					</SettingsSection>
					{thread ? (
						<View style={{ gap: 12 }}>
							<Text style={{ color: colors.foregroundMuted }}>
								{thread.model} ·{" "}
								{thread.context === "recent"
									? "Main-context snapshot"
									: "No main context"}
								{thread.contextTruncated ? " · Earlier context omitted" : ""}
							</Text>
							{thread.turns.map((turn, index) => (
								<SettingsSection
									key={`${thread.id}:${index}`}
									title={`Exchange ${index + 1}`}
								>
									<SettingsCard>
										<View style={{ padding: 12, gap: 12 }}>
											<Text
												selectable
												style={{ color: colors.foreground, fontWeight: "600" }}
											>
												{turn.question}
											</Text>
											<Text
												selectable
												style={{ color: colors.foreground, lineHeight: 22 }}
											>
												{turn.answer}
											</Text>
											{button("Copy answer", () => {
												void copyText(turn.answer).then(
													() => {
														saved.message =
															"Answer copied. Paste it into the main draft when ready.";
														refreshView();
													},
													() => {
														saved.message =
															"Could not copy. Select the answer text to copy it.";
														refreshView();
													},
												);
											})}
										</View>
									</SettingsCard>
								</SettingsSection>
							))}
							{thread.state === "running" ? (
								<SettingsSection title="Answering">
									<SettingsCard>
										<View style={{ padding: 12, gap: 12 }}>
											<Text
												style={{ color: colors.foreground, fontWeight: "600" }}
											>
												{thread.question}
											</Text>
											<Text selectable style={{ color: colors.foreground }}>
												{thread.partial || "Thinking…"}
											</Text>
											{button(
												"Stop response",
												() => void mutate("cancel"),
												blocked,
											)}
										</View>
									</SettingsCard>
								</SettingsSection>
							) : null}
							{thread.state === "cancelled" ? (
								<Text style={{ color: colors.foregroundMuted }}>
									Response cancelled. Completed exchanges are retained.
								</Text>
							) : null}
							{thread.error ? (
								<Text style={{ color: colors.statusWarning }}>
									{thread.error}
								</Text>
							) : null}
							{button(
								"Delete side conversation",
								() => {
									if (saved.deleteConfirm !== thread.id) {
										saved.deleteConfirm = thread.id;
										saved.message =
											"Delete this side conversation? Tap Delete again to confirm.";
										refreshView();
									} else {
										saved.deleteConfirm = undefined;
										void mutate("remove");
									}
								},
								blocked,
							)}
						</View>
					) : selected ? (
						<Text style={{ color: colors.foregroundMuted }}>
							{saved.busy || query.isFetching
								? "Loading selected conversation…"
								: "Selected conversation is no longer available. Choose another conversation."}
						</Text>
					) : null}
					{saved.message ? (
						<Text
							accessibilityRole="alert"
							style={{
								color: saved.uncertain
									? colors.statusWarning
									: colors.foregroundMuted,
							}}
						>
							{saved.message}
						</Text>
					) : null}
					{saved.uncertain
						? button(
								"I reviewed the refreshed status",
								() => {
									saved.uncertain = false;
									saved.message = undefined;
									refreshView();
								},
								saved.busy ||
									saved.refreshed <= saved.failedAt ||
									query.isError ||
									query.isFetching,
							)
						: null}
					<TextInput
						accessibilityLabel="BTW question"
						placeholder={thread ? "Ask a follow-up…" : "Ask a side question…"}
						multiline
						maxLength={8000}
						editable={!blocked && thread?.state !== "running"}
						value={draft}
						onChangeText={(text) => {
							saved.drafts[draftKey] = {
								text,
								revision: (saved.drafts[draftKey]?.revision ?? 0) + 1,
							};
							refreshView();
						}}
						style={{
							color: colors.foreground,
							backgroundColor: colors.surface1,
							borderColor: colors.border,
							borderWidth: 1,
							borderRadius: 10,
							padding: 12,
							minHeight: 90,
						}}
					/>
					{button(
						thread ? "Send follow-up" : "Ask BTW",
						() => void mutate(selected ? "send" : "start"),
						blocked ||
							!draft.trim() ||
							thread?.state === "running" ||
							(!!selected && !thread),
					)}
					<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
						Temporary history · cleared when Pi reloads or switches sessions.
					</Text>
				</>
			) : null}
		</ScrollView>
	);
}

export function contributeBtw(client: PluginClientContext) {
	const entries = new Map<
		string,
		{ workspace: string; button: PluginButtonRegistration }
	>();
	const controller = new AbortController();
	let stopped = false;
	const dispose = client.addWorkspacePanel({
		id: "pi-btw",
		title: "BTW",
		icon: "MessagesSquare",
		context: "agent",
		locations: ["workspace"],
		Component: BtwPanel,
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
				id: "pi-btw",
				agentId: agent.id,
				workspaceId,
				button: {
					label: "BTW",
					title: "Side conversations",
					icon: "MessagesSquare",
					behavior: {
						kind: "action",
						onPress: () =>
							client.openPanel("pi-btw", { agentId: agent.id, workspaceId }),
					},
				},
			}),
		});
	};
	void client.paseo.agents
		.list({ subscribe: {}, signal: controller.signal })
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
			if (!stopped) console.error("BTW subscription unavailable", error);
		});
	return () => {
		stopped = true;
		controller.abort();
		for (const id of entries.keys()) remove(id);
		dispose();
	};
}
