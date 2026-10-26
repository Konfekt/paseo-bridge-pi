import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { Metadata, NativeRow, SectionHeading, Surface } from "./presentation";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import {
	type PluginButtonContentProps,
	type PluginButtonRegistration,
	type PluginClientContext,
	useRpc,
} from "@getpaseo/plugin/client";
import {
	accountControlsStatusRpc,
	accountControlsSwitchRpc,
	type AccountControlsSnapshot,
	type AccountProviderId,
} from "../shared/account-controls";
import type { Colors } from "./activity-dashboard";

type Agent = {
	id: string;
	name?: string | null;
	title?: string | null;
	workspaceId?: string | null;
	provider?: string;
	archivedAt?: string | null;
};
type Selection = { agentId: string; sessionId: string; runtimeEpoch: string };
const selectedSessions = new Map<string, Selection>();

export function contributeAccountControls(client: PluginClientContext) {
	const stopChat = contributeChatAccountControls(client);
	let disposed = false;
	let stop: (() => void) | undefined;
	void client.paseo.config
		.get()
		.then(({ config }) => {
			const plugins = config.plugins;
			const entry =
				plugins && typeof plugins === "object" && !Array.isArray(plugins)
					? (plugins as Record<string, unknown>)["paseo-accounts"]
					: undefined;
			return (
				!!entry &&
				typeof entry === "object" &&
				(entry as { enabled?: boolean }).enabled !== false
			);
		})
		.catch(() => false)
		.then((external) => {
			if (!disposed && !external)
				stop = contributeLegacyAccountControls(client);
		});
	return () => {
		disposed = true;
		stopChat();
		stop?.();
	};
}

export function contributeChatAccountControls(client: PluginClientContext) {
	const entries = new Map<string, { workspaceId: string; button: PluginButtonRegistration }>();
	const controller = new AbortController();
	let stopped = false;
	const remove = (id: string) => { entries.get(id)?.button.remove(); entries.delete(id); };
	const register = (agent: Agent) => {
		if (stopped) return;
		if (agent.provider !== "pi" || agent.archivedAt || !agent.workspaceId) { remove(agent.id); return; }
		if (entries.get(agent.id)?.workspaceId === agent.workspaceId) return;
		remove(agent.id);
		const Content = (props: PluginButtonContentProps) => {
			if (props.context !== "agent" || props.agentId !== agent.id || props.workspaceId !== agent.workspaceId) return <View />;
			return <View style={{ width: 340, maxWidth: "100%", padding: 12 }}>
				<Metadata colors={props.theme.colors}>This chat and inheriting descendants only. Parent and sibling chats are unchanged.</Metadata>
				<ProviderAccountSection key={`${props.host.id}/${props.agentId}`} agentId={props.agentId} workspaceId={props.workspaceId} hostId={props.host.id} colors={props.theme.colors} providerId="openai-codex" onBinding={() => {}} />
			</View>;
		};
		const button = client.addComposerPill({ id: "pi-codex-account", workspaceId: agent.workspaceId, agentId: agent.id,
			button: { title: "Codex account · this chat", label: "Codex", icon: "UserRound", behavior: { kind: "popover", Content } } });
		entries.set(agent.id, { workspaceId: agent.workspaceId, button });
	};
	void client.paseo.agents.list({ includeBackground: true, subscribe: {}, signal: controller.signal }).then(({ subscription }) => {
		if (stopped) return;
		subscription.subscribe({
			snapshot: ({ entries: agents }) => { if (stopped) return; const ids = new Set(agents.map(({ agent }) => agent.id)); for (const id of entries.keys()) if (!ids.has(id)) remove(id); for (const { agent } of agents) register(agent); },
			update: (message) => { if (stopped || message.type !== "agent_update") return; if (message.payload.kind === "remove") remove(message.payload.agentId); else register(message.payload.agent); },
		});
	}).catch(() => {});
	return () => { stopped = true; controller.abort(); for (const id of entries.keys()) remove(id); };
}

function contributeLegacyAccountControls(client: PluginClientContext) {
	const entries = new Map<
		string,
		{
			workspaceId: string;
			agents: Map<string, Agent>;
			button: PluginButtonRegistration;
		}
	>();
	const lifetime = new AbortController();
	let stopped = false;
	const remove = (id: string) => {
		for (const [workspace, entry] of entries) {
			if (entry.agents.delete(id) && entry.agents.size === 0) {
				entry.button.remove();
				entries.delete(workspace);
			}
		}
	};
	const register = (agent: Agent) => {
		if (
			agent.provider !== "pi" ||
			agent.archivedAt ||
			!agent.workspaceId ||
			stopped
		) {
			remove(agent.id);
			return;
		}
		const workspaceId = agent.workspaceId;
		const old = [...entries.entries()].find(([, entry]) =>
			entry.agents.has(agent.id),
		);
		if (old && old[0] !== workspaceId) remove(agent.id);
		const existing = entries.get(workspaceId);
		if (existing) {
			existing.agents.set(agent.id, agent);
			return;
		}
		const agents = new Map([[agent.id, agent]]);
		const Content = (props: PluginButtonContentProps) => (
			<AccountsPopover {...props} paseo={client.paseo} />
		);
		const button = client.addHeaderButton({
			id: "pi-accounts",
			workspaceId,
			button: {
				title: "Pi account controls",
				label: "Accounts",
				icon: "UserRound",
				behavior: { kind: "popover", Content },
			},
		});
		entries.set(workspaceId, { workspaceId, agents, button });
	};
	void client.paseo.agents
		.list({ subscribe: {}, signal: lifetime.signal })
		.then(({ subscription }) => {
			if (stopped) return;
			subscription.subscribe({
				snapshot: ({ entries: agents }) => {
					if (stopped || lifetime.signal.aborted) return;
					const relevant = agents
						.map(({ agent }) => agent)
						.filter(
							(a) => a.provider === "pi" && !a.archivedAt && a.workspaceId,
						);
					const ids = new Set(relevant.map((a) => a.id));
					for (const entry of entries.values())
						for (const id of [...entry.agents.keys()])
							if (!ids.has(id)) remove(id);
					for (const agent of relevant) register(agent);
				},
				update: (message) => {
					if (
						stopped ||
						lifetime.signal.aborted ||
						message.type !== "agent_update"
					)
						return;
					if (message.payload.kind === "remove") {
						remove(message.payload.agentId);
					} else register(message.payload.agent);
				},
			});
		})
		.catch((error) => {
			if (!stopped)
				console.error("Account controls agent observation failed", error);
		});
	return () => {
		stopped = true;
		lifetime.abort();
		for (const entry of entries.values()) entry.button.remove();
		entries.clear();
	};
}

function AccountsPopover(
	props: PluginButtonContentProps & { paseo: PluginClientContext["paseo"] },
) {
	return (
		<AccountsView
			key={`${props.host.id}:${props.workspaceId}`}
			{...props}
			paseo={props.paseo}
		/>
	);
}
function AccountsView({
	workspaceId,
	host,
	theme,
	paseo,
}: PluginButtonContentProps & {
	workspaceId: string;
	paseo: PluginClientContext["paseo"];
}) {
	const [selection, setSelection] = useState<Selection | undefined>(
		selectedSessions.get(`${host.id}\0${workspaceId}`),
	);
	const [agents, setAgents] = useState<Agent[]>([]);
	const lifetime = `${host.id}\0${workspaceId}`;
	useEffect(() => {
		let active = true;
		const controller = new AbortController();
		void paseo.agents
			.list({ subscribe: {}, signal: controller.signal })
			.then(({ subscription }) => {
				if (!active) return;
				subscription.subscribe({
					snapshot: ({ entries }) => {
						if (active)
							setAgents(
								entries
									.map(({ agent }) => agent)
									.filter(
										(a) =>
											a.provider === "pi" &&
											!a.archivedAt &&
											a.workspaceId === workspaceId,
									),
							);
					},
					update: (m) => {
						if (!active || m.type !== "agent_update") return;
						setAgents((current) =>
							m.payload.kind === "remove"
								? current.filter((a) => a.id !== m.payload.agentId)
								: m.payload.agent.provider === "pi" &&
										!m.payload.agent.archivedAt &&
										m.payload.agent.workspaceId === workspaceId
									? [
											...current.filter((a) => a.id !== m.payload.agent.id),
											m.payload.agent,
										]
									: current.filter((a) => a.id !== m.payload.agent.id),
						);
					},
				});
			})
			.catch(() => {});
		return () => {
			active = false;
			controller.abort();
		};
	}, [paseo, workspaceId]);
	const choose = (agent: Agent) => {
		const next = { agentId: agent.id, sessionId: "", runtimeEpoch: "" };
		setSelection(next);
		selectedSessions.set(lifetime, next);
	};
	const publishBinding = (expectedAgentId: string, binding: Selection) => {
		const latest = selectedSessions.get(lifetime);
		if (
			latest?.agentId !== expectedAgentId ||
			binding.agentId !== expectedAgentId
		)
			return;
		setSelection((current) =>
			current?.agentId === expectedAgentId ? binding : current,
		);
		selectedSessions.set(lifetime, binding);
	};
	const boundAgent = selection
		? agents.find((a) => a.id === selection.agentId)
		: undefined;
	const sole = agents.length === 1 ? agents[0] : undefined;
	const chosen = selection ? boundAgent : sole;
	useEffect(() => {
		if (!selection && sole) {
			const next = { agentId: sole.id, sessionId: "", runtimeEpoch: "" };
			setSelection(next);
			selectedSessions.set(lifetime, next);
		}
	}, [selection, sole?.id]);
	const colors = theme.colors;
	return (
		<ScrollView
			style={{ maxHeight: 520 }}
			contentContainerStyle={{ gap: 12, padding: 12 }}
		>
			<SectionHeading colors={colors} title="Pi accounts" />
			{agents.length > 1 ? (
				<Metadata colors={colors}>Choose the Pi session to manage.</Metadata>
			) : null}
			{agents.length === 0 ? (
				<Surface colors={colors} padded>
					<Metadata colors={colors}>No Pi sessions in this workspace.</Metadata>
				</Surface>
			) : null}
			{agents.length > 0 ? (
				<Surface colors={colors}>
					{agents.map((a) => (
						<NativeRow
							key={a.id}
							colors={colors}
							title={a.title || a.name || shortId(a.id)}
							selected={selection?.agentId === a.id}
							onPress={() => choose(a)}
						/>
					))}
				</Surface>
			) : null}
			{selection && !boundAgent ? (
				<Metadata colors={colors} style={{ color: colors.statusWarning }}>
					Selected Pi session is no longer in this workspace. Choose another
					session explicitly.
				</Metadata>
			) : null}
			{chosen ? (
				<AccountSection
					key={chosen.id}
					hostId={host.id}
					workspaceId={workspaceId}
					agentId={chosen.id}
					colors={colors}
					onBinding={(s) => publishBinding(chosen.id, s)}
				/>
			) : null}
		</ScrollView>
	);
}
const locks = new Map<
	string,
	{
		state: "pending" | "uncertain";
		serviceEpoch: string;
		statusSequenceAtFailure?: number;
	}
>();
let sequence = 0;
type AccountSectionProps = {
  agentId: string; workspaceId: string; hostId: string; colors: Colors;
  onBinding: (selection: Selection) => void;
};
function AccountSection(props: AccountSectionProps) {
  const [providerId, setProviderId] = useState<AccountProviderId>("openai");
  return <View style={{ gap: 8 }}>
    <SettingsSelect label="Provider" value={providerId} onValueChange={setProviderId}
      options={[{label:"OpenAI",value:"openai"},{label:"OpenAI Codex",value:"openai-codex"}]} />
    <Metadata colors={props.colors}>Changes this session and inheriting descendants, preserving its role model. Parent and sibling sessions are unchanged.</Metadata>
    <ProviderAccountSection key={`${props.agentId}/${providerId}`} {...props} providerId={providerId} />
  </View>;
}
function ProviderAccountSection({
  providerId,
	agentId,
	workspaceId,
	hostId,
	colors,
	onBinding,
}: {
	agentId: string;
	workspaceId: string;
	hostId: string;
	colors: Colors;
	onBinding: (s: Selection) => void;
  providerId: AccountProviderId;
}) {
	const status = useRpc(accountControlsStatusRpc),
		change = useRpc(accountControlsSwitchRpc);
	const [choice, setChoice] = useState<{
			id: string | null;
			label: string;
			key: string;
			inherit?: boolean;
		}>(),
		[switching, setSwitching] = useState(false),
		[failure, setFailure] = useState<string>(),
		[linkFailure, setLinkFailure] = useState(false);
	const [bound, setBound] = useState<Selection | undefined>(
		selectedSessions.get(`${hostId}\0${workspaceId}`)?.agentId === agentId
			? selectedSessions.get(`${hostId}\0${workspaceId}`)
			: undefined,
	);
	const query = useQuery({
		queryKey: ["pi-account-controls", hostId, agentId, workspaceId, providerId],
		queryFn: async () => {
			const n = ++sequence;
			const d = await status({ agentId, workspaceId, ...(providerId === "openai-codex" ? { providerId } : {}) });
			if (d.available && d.sessionId && d.runtimeEpoch) {
				if (
					bound?.sessionId &&
					(bound.sessionId !== d.sessionId ||
						bound.runtimeEpoch !== d.runtimeEpoch)
				) {
					/* Preserve old binding and report stale. */
				} else {
					const s = {
						agentId,
						sessionId: d.sessionId,
						runtimeEpoch: d.runtimeEpoch,
					};
					setBound(s);
					onBinding(s);
					const k = key(
							hostId,
							agentId,
							d.sessionId,
							d.runtimeEpoch,
							d.snapshot.serviceEpoch,
              providerId,
						),
						l = locks.get(k);
					if (
						l?.state === "uncertain" &&
						n > (l.statusSequenceAtFailure ?? Number.MAX_SAFE_INTEGER)
					)
						locks.delete(k);
				}
			}
			return d;
		},
		refetchInterval: 5000,
		refetchOnReconnect: true,
		staleTime: 0,
	});
	const raw =
		query.data?.available &&
		query.data.sessionId === bound?.sessionId &&
		query.data.runtimeEpoch === bound?.runtimeEpoch
			? query.data.snapshot
			: undefined;
	const snap: AccountControlsSnapshot | undefined = !query.isError
		? raw
		: undefined;
	const lk = raw
		? key(
				hostId,
				agentId,
				bound!.sessionId,
				bound!.runtimeEpoch,
				raw.serviceEpoch,
        providerId,
			)
		: undefined;
	const lock = lk ? locks.get(lk) : undefined;
	const blocked =
		!!lock ||
		switching ||
		query.isError ||
		query.isFetching ||
		!snap ||
		!snap.canSwitch ||
		snap.busy;
	const current = snap?.inheritance === "inherited"
		? "Following parent account · resolved for each request"
		: snap?.defaultSelected
		? "Pi built-in login"
		: (snap?.accounts.find((a) => a.id === snap.currentAccountId)?.label ??
			"Account unavailable");
	const confirm = async () => {
		const c = choice;
		if (!c || blocked || !snap || locks.has(c.key)) return;
		const reservation = {
			state: "pending" as const,
			serviceEpoch: snap.serviceEpoch,
		};
		locks.set(c.key, reservation);
		setSwitching(true);
		setFailure(undefined);
		try {
			const checked = await query.refetch(),
				fresh =
					checked.data?.available &&
					checked.data.sessionId === bound?.sessionId &&
					checked.data.runtimeEpoch === bound?.runtimeEpoch
						? checked.data.snapshot
						: undefined;
			if (locks.get(c.key) !== reservation) return;
			if (
				checked.isError ||
				!fresh ||
				fresh.serviceEpoch !== snap.serviceEpoch ||
				fresh.selectionRevision !== snap.selectionRevision ||
				fresh.busy ||
				!fresh.canSwitch ||
				key(
					hostId,
					agentId,
					bound!.sessionId,
					bound!.runtimeEpoch,
					fresh.serviceEpoch,
          providerId,
				) !== c.key ||
				(c.id !== null && !fresh.accounts.some((a) => a.id === c.id))
			) {
				locks.delete(c.key);
				setFailure(
					"Account status changed. Refresh and review the current selection.",
				);
				setChoice(undefined);
				return;
			}
			setChoice(undefined);
			let result;
			try {
				result = await change({
					agentId,
					workspaceId,
					expectedSessionId: bound!.sessionId,
					expectedRuntimeEpoch: bound!.runtimeEpoch,
					request: {
						protocol: 1,
						requestId: rid(),
						expectedSessionId: bound!.sessionId,
						expectedServiceEpoch: fresh.serviceEpoch,
						expectedSelectionRevision: fresh.selectionRevision,
            ...(providerId === "openai-codex" ? { providerId } : {}),
						accountId: c.id,
						...(c.inherit ? { inherit: true } : {}),
					},
				});
			} catch {
				if (locks.get(c.key) === reservation)
					locks.set(c.key, {
						state: "uncertain",
						serviceEpoch: fresh.serviceEpoch,
						statusSequenceAtFailure: sequence,
					});
				setFailure(
					"Switch outcome uncertain. Account changes are locked until status refresh succeeds.",
				);
				return;
			}
			if (locks.get(c.key) === reservation) locks.delete(c.key);
			if (!result.ok)
				setFailure(
					result.reason === "busy"
						? "Pi became busy. Try again when idle."
						: result.reason === "stale-selection"
							? "Selection changed elsewhere. Refresh status."
							: result.reason === "activation-failed"
								? "Account activation failed. Refresh status."
								: result.reason === "stale-session" ||
										result.reason === "stale-service"
									? "Pi session changed. Refresh accounts."
									: "Account switch failed. Refresh status.",
				);
			try {
				await query.refetch();
			} catch {
				setFailure("Account status refresh failed.");
			}
		} catch {
			if (locks.get(c.key) === reservation) locks.delete(c.key);
			setFailure(
				"Could not confirm current account status. Refresh and try again.",
			);
		} finally {
			setSwitching(false);
		}
	};
	const settings = snap?.usage.settingsUrl;
	const credential =
		snap?.usage.effectiveCredential === "api-key-configured"
			? "API key"
			: snap?.usage.effectiveCredential?.startsWith("chatgpt-grant")
				? "ChatGPT"
				: "OpenAI";
	return (
		<SettingsSection title="Account">
			<SettingsCard>
				<View style={{ padding: 12, gap: 8 }}>
					<Text style={{ color: colors.foreground, fontSize: 13 }}>
						{query.isPending
							? "Checking account…"
							: snap
								? current
								: "Account status unavailable"}
					</Text>
					<NativeRow
						colors={colors}
						title="Refresh account status"
						disabled={query.isFetching}
						onPress={() => void query.refetch()}
					/>
					{bound &&
					query.data?.available &&
					(query.data.sessionId !== bound.sessionId ||
						query.data.runtimeEpoch !== bound.runtimeEpoch) ? (
						<>
							<Text style={{ color: colors.statusWarning }}>
								Selected Pi session changed. Select it again to bind its current
								runtime.
							</Text>
							<Pressable
								accessibilityRole="button"
								onPress={() => {
									const next = {
										agentId,
										sessionId: query.data!.sessionId!,
										runtimeEpoch: query.data!.runtimeEpoch!,
									};
									setBound(next);
									onBinding(next);
								}}
								style={{ minHeight: 44, justifyContent: "center" }}
							>
								<Text style={{ color: colors.accent }}>
									Bind current session
								</Text>
							</Pressable>
						</>
					) : null}
					{query.isError ? (
						<Text style={{ color: colors.statusWarning }}>
							Account status refresh failed. Controls disabled.
						</Text>
					) : null}
					{!query.isPending && !query.isError && !query.data?.available ? (
						<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
							Reload Pi, then refresh accounts.
						</Text>
					) : null}
					{snap && snap.accounts.length === 0 ? (
						<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
							Add a named account in Pi with /accounts.
						</Text>
					) : null}
					{snap?.accounts.map((a) => (
						<Pressable
							key={a.id}
							accessibilityRole="button"
							accessibilityState={{
								disabled:
									blocked ||
									(a.id === snap.currentAccountId && !snap.defaultSelected && snap.inheritance !== "inherited"),
								selected:
									a.id === snap.currentAccountId && !snap.defaultSelected && snap.inheritance !== "inherited",
							}}
							disabled={
								blocked ||
								(a.id === snap.currentAccountId && !snap.defaultSelected && snap.inheritance !== "inherited")
							}
							onPress={() => {
								if (!blocked && lk)
									setChoice({ id: a.id, label: a.label, key: lk });
							}}
							style={{
								minHeight: 44,
								justifyContent: "center",
								opacity: blocked ? 0.5 : 1,
							}}
						>
							<Text style={{ color: colors.accent }}>
								{a.label}
								{a.id === snap.currentAccountId && !snap.defaultSelected && snap.inheritance !== "inherited"
									? " · Current"
									: ""}
							</Text>
						</Pressable>
					))}
					{snap?.inheritance ? <NativeRow colors={colors} title={snap.inheritance === "inherited" ? "Following parent account" : "Follow parent account"} disabled={blocked || snap.inheritance === "inherited"} onPress={() => { if (lk) setChoice({ id: null, label: "Follow parent account", key: lk, inherit: true }); }} /> : null}
					{snap && (!snap.defaultSelected || snap.inheritance === "inherited") ? (
						<Pressable
							accessibilityRole="button"
							disabled={blocked}
							onPress={() =>
								lk &&
								setChoice({ id: null, label: "Pi built-in login", key: lk })
							}
							style={{
								minHeight: 44,
								justifyContent: "center",
								opacity: blocked ? 0.5 : 1,
							}}
						>
							<Text style={{ color: colors.accent }}>
								Use Pi built-in login
							</Text>
						</Pressable>
					) : null}
					{snap && (snap.busy || !snap.canSwitch) ? (
						<Text style={{ color: colors.foregroundMuted }}>
							Switching is available when Pi is idle.
						</Text>
					) : null}
					{lock ? (
						<Text style={{ color: colors.statusWarning }}>
							{lock.state === "pending"
								? "Switching account…"
								: "Outcome uncertain. Refresh before another change."}
						</Text>
					) : null}
					{failure ? (
						<Text style={{ color: colors.statusWarning }}>{failure}</Text>
					) : null}
					{choice ? (
						<View
							accessibilityRole="alert"
							style={{
								padding: 12,
								borderRadius: 10,
								backgroundColor: colors.surface2,
								gap: 8,
							}}
						>
							<Text style={{ color: colors.foreground }}>
								Use {choice.label} for this Pi session?
							</Text>
							<Pressable
								accessibilityRole="button"
								style={{ minHeight: 44, justifyContent: "center" }}
								onPress={() => void confirm()}
								disabled={blocked}
							>
								<Text style={{ color: colors.accent }}>Confirm switch</Text>
							</Pressable>
							<Pressable
								accessibilityRole="button"
								style={{ minHeight: 44, justifyContent: "center" }}
								onPress={() => setChoice(undefined)}
								disabled={switching}
							>
								<Text style={{ color: colors.foregroundMuted }}>Cancel</Text>
							</Pressable>
						</View>
					) : null}
					{snap ? (
						<>
							<Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
								Authentication status · {credential} ·{" "}
								{snap.usage.status === "local-binding-confirmed"
									? "Configured"
									: "unavailable"}
							</Text>
							{settings ? (
								<>
									<Pressable
										accessibilityRole="link"
										onPress={() => {
											setLinkFailure(false);
											void Linking.openURL(settings).catch(() =>
												setLinkFailure(true),
											);
										}}
										style={{ minHeight: 44, justifyContent: "center" }}
									>
										<Text style={{ color: colors.accent }}>
											Open usage settings
										</Text>
									</Pressable>
									{linkFailure ? (
										<Text style={{ color: colors.statusWarning }}>
											Could not open settings: {settings}
										</Text>
									) : null}
								</>
							) : null}
						</>
					) : null}
				</View>
			</SettingsCard>
		</SettingsSection>
	);
}
function shortId(value: string) {
	return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
function key(...parts: string[]) {
	return JSON.stringify(parts);
}
function rid() {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === "x" ? r : (r & 3) | 8).toString(16);
	});
}
