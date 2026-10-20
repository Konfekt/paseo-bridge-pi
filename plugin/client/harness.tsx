import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRpc, type PluginAgentPanelProps, type PluginButtonContentProps, type PluginButtonIconProps, type PluginClientContext, type PluginButtonRegistration } from "@getpaseo/plugin/client";
import { harnessStatusRpc, harnessJobsListRpc, harnessJobsOutputRpc, harnessSubagentsListRpc, harnessSubagentReportRpc } from "../shared/harness-readonly";

import { ForegroundTasksSection } from "./foreground-tasks";
import { foregroundTasksStatusRpc } from "../shared/foreground-tasks";

type Kind = "jobs" | "subagents";
type Agent = { id: string; workspaceId?: string | null; provider?: string; archivedAt?: string | null };

/** Registration is local. Queries run only for a mounted button or open view. */
export function contributeHarness(client: PluginClientContext) {
  const entries = new Map<string, { workspaceId: string; buttons: PluginButtonRegistration[] }>();
  const lifetime = new AbortController();
  let stopped = false;
  const panels = [
    client.addWorkspacePanel({ id: "harness-jobs", title: "Background jobs", icon: "Terminal", context: "agent", locations: ["workspace"], Component: JobsPanel }),
    client.addWorkspacePanel({ id: "harness-subagents", title: "Pi subagents", icon: "Users", context: "agent", locations: ["workspace"], Component: SubagentsPanel }),
  ];
  const remove = (id: string) => { entries.get(id)?.buttons.forEach(button => button.remove()); entries.delete(id); };
  const register = (agent: Agent) => {
    if (stopped) return;
    if (agent.provider !== "pi" || agent.archivedAt || !agent.workspaceId) { remove(agent.id); return; }
    if (entries.get(agent.id)?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    const workspaceId = agent.workspaceId;
    const entry = { workspaceId, buttons: [] as PluginButtonRegistration[] };
    const report = (label: string, title: string) => {
      if (!stopped && entries.get(agent.id) === entry) entry.buttons[0]?.update({ label, title });
    };
    entry.buttons.push(client.addComposerPill({
      id: "tasks", workspaceId, agentId: agent.id,
      button: { title: "Tasks", label: "Tasks", icon: props => <TasksIndicator {...props} report={report} />,
        behavior: { kind: "popover", Content: props => <TasksPopover {...props} openPanel={kind => {
          if (!stopped && entries.get(agent.id) === entry) {
            client.openPanel(`harness-${kind}`, { workspaceId, agentId: agent.id });
            props.close();
          }
        }} /> },
      },
    }));
    entries.set(agent.id, entry);
  };
  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (stopped) return;
    subscription.subscribe({
      snapshot: ({ entries: agents }) => {
        const ids = new Set(agents.map(({ agent }) => agent.id));
        for (const id of entries.keys()) if (!ids.has(id)) remove(id);
        for (const { agent } of agents) register(agent);
      },
      update: message => {
        if (message.type !== "agent_update") return;
        if (message.payload.kind === "remove") remove(message.payload.agentId); else register(message.payload.agent);
      },
    });
  }).catch(error => { if (!stopped) console.error("Read-only harness observation unavailable", error); });
  return () => { stopped = true; lifetime.abort(); for (const id of entries.keys()) remove(id); panels.forEach(dispose => dispose()); };
}

function JobsPanel(props: PluginAgentPanelProps) { return <HarnessPanel {...props} kind="jobs" />; }
function SubagentsPanel(props: PluginAgentPanelProps) { return <HarnessPanel {...props} kind="subagents" />; }

type TaskScope = { agentId: string; workspaceId: string; host: { id: string } };
function useTaskSummary({ agentId, workspaceId, host }: TaskScope) {
  const statusCall = useRpc(harnessStatusRpc), jobsCall = useRpc(harnessJobsListRpc), agentsCall = useRpc(harnessSubagentsListRpc), foregroundCall = useRpc(foregroundTasksStatusRpc);
  const target = { agentId, workspaceId };
  const identity = useQuery({ queryKey: ["harness-status", agentId, workspaceId, host.id], queryFn: () => statusCall(target), refetchInterval: 5000, refetchOnReconnect: true });
  const session = identity.data?.sessionId, epoch = identity.data?.runtimeEpoch;
  const ready = identity.data?.available === true && !!session && !!epoch && !identity.isError;
  const bound = { ...target, expectedSessionId: session!, expectedRuntimeEpoch: epoch! };
  const jobs = useQuery({ queryKey: ["harness-list", "jobs", agentId, workspaceId, session, epoch, host.id], enabled: ready, queryFn: () => jobsCall({ ...bound, limit: 50 }), refetchInterval: 5000, refetchOnReconnect: true });
  const agents = useQuery({ queryKey: ["harness-list", "subagents", agentId, workspaceId, session, epoch, host.id], enabled: ready, queryFn: () => agentsCall({ ...bound, limit: 50 }), refetchInterval: 5000, refetchOnReconnect: true });
  const foreground = useQuery({ queryKey: ["foreground-tasks", host.id, agentId, workspaceId], queryFn: () => foregroundCall(target), refetchInterval: 2000, refetchOnReconnect: true, staleTime: 1000 });
  const count = (rows: readonly { status: string }[] | undefined) => rows ? ({ total: rows.length,
    running: rows.filter(row => ["running", "pending", "starting", "launching"].includes(row.status)).length,
    attention: rows.filter(row => /waiting|blocked|failed|lost|needs/.test(row.status)).length }) : undefined;
  return {
    jobs: count(ready && !jobs.isError && jobs.data?.state === "available" ? jobs.data.items : undefined),
    subagents: count(ready && !agents.isError && agents.data?.state === "available" ? agents.data.items : undefined),
    foreground: count(!foreground.isError && foreground.data?.available ? foreground.data.tasks : undefined),
  };
}
function TasksIndicator(props: PluginButtonIconProps & { report(label: string, title: string): void }) {
  if (props.context !== "agent") return <Icon name="ListTodo" size={props.size} color={props.color} />;
  return <MountedTasksIndicator {...props} />;
}
function MountedTasksIndicator(props: Extract<PluginButtonIconProps, { context: "agent" }> & { report(label: string, title: string): void }) {
  const summary = useTaskSummary(props);
  const attention = Object.values(summary).some(value => !!value?.attention);
  const running = Object.values(summary).some(value => !!value?.running);
  const label = attention ? "Tasks · attention" : running ? "Tasks · running" : "Tasks";
  // Counts stay category-specific: foreground helpers may also appear under Agents.
  const title = "Tasks";
  useEffect(() => { props.report(label, title); }, [label, title, props.report]);
  return <Icon name="ListTodo" size={props.size} color={attention ? props.theme.colors.statusDanger : props.color} />;
}
function TasksPopover(props: PluginButtonContentProps & { openPanel(kind: Kind): void }) {
  if (props.context !== "agent") return <View />;
  return <TasksPanel {...props} />;
}
function TasksPanel(props: Extract<PluginButtonContentProps, { context: "agent" }> & { openPanel(kind: Kind): void }) {
  const [section, setSection] = useState<"jobs" | "subagents" | "foreground">("foreground");
  const summary = useTaskSummary(props);
  const labels = { jobs: "Jobs", subagents: "Agents", foreground: "Foreground" };
  const fg = props.theme.colors.foreground, muted = props.theme.colors.foregroundMuted;
  return <View style={{ width: "100%", minWidth: 280, maxWidth: 520, gap: 8 }}>
    <Text accessibilityRole="header" style={{ color: fg, fontSize: 18, paddingHorizontal: 12 }}>Tasks</Text>
    <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 4, paddingHorizontal: 8 }}>
      {(["foreground", "jobs", "subagents"] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityLabel={labels[value]} accessibilityState={{ selected: section === value }} onPress={() => setSection(value)} style={{ flex: 1, padding: 10, borderBottomWidth: 2, borderBottomColor: section === value ? fg : "transparent" }}>
        <Text style={{ color: section === value ? fg : muted }}>{labels[value]}{summary[value] ? ` · ${summary[value]!.total}` : ""}{summary[value]?.attention ? " !" : ""}</Text>
      </Pressable>)}
    </View>
    {section !== "foreground" ? <Pressable accessibilityRole="button" accessibilityLabel={`Open ${labels[section]} panel`} onPress={() => props.openPanel(section)} style={{ paddingHorizontal: 16, paddingVertical: 8 }}><Text style={{ color: fg }}>Open {labels[section]} panel</Text></Pressable> : null}
    {section === "foreground" ? <ForegroundTasksSection {...props} /> : <HarnessPanel {...props} kind={section} embedded />}
  </View>;
}

function elapsed(start: string, end?: string | null) {
  const milliseconds = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

function HarnessPanel({ kind, agentId, workspaceId, theme, navigation, host, embedded = false }: PluginAgentPanelProps & { kind: Kind; embedded?: boolean }) {
  const statusCall = useRpc(harnessStatusRpc);
  const jobsCall = useRpc(harnessJobsListRpc);
  const tasksCall = useRpc(harnessSubagentsListRpc);
  const outputCall = useRpc(harnessJobsOutputRpc);
  const reportCall = useRpc(harnessSubagentReportRpc);
  const [selected, select] = useState<{ id: string; session: string; epoch: string } | null>(null);
  const target = { agentId, workspaceId };
  const identity = useQuery({ queryKey: ["harness-status", agentId, workspaceId, host.id], queryFn: () => statusCall(target), refetchInterval: 5000, refetchOnReconnect: true });
  const session = identity.data?.sessionId;
  const epoch = identity.data?.runtimeEpoch;
  const ready = identity.data?.available === true && !!session && !!epoch && !identity.isError;
  const bound = { ...target, expectedSessionId: session!, expectedRuntimeEpoch: epoch! };
  const list = useQuery({
    queryKey: ["harness-list", kind, agentId, workspaceId, session, epoch, host.id], enabled: ready,
    queryFn: () => kind === "jobs" ? jobsCall({ ...bound, limit: 50 }) : tasksCall({ ...bound, limit: 50 }),
    refetchInterval: 5000, refetchOnReconnect: true,
  });
  const selectedId = selected && selected.session === session && selected.epoch === epoch ? selected.id : undefined;
  const detail = useQuery({
    queryKey: ["harness-detail", kind, agentId, workspaceId, session, epoch, selectedId, host.id], enabled: ready && !!selectedId,
    queryFn: () => kind === "jobs" ? outputCall({ ...bound, jobId: selectedId!, maxBytes: 24000 }) : reportCall({ ...bound, taskId: selectedId!, maxBytes: 24000 }),
    refetchInterval: 5000, refetchOnReconnect: true,
  });
  const fg = theme.colors.foreground, muted = theme.colors.foregroundMuted, danger = theme.colors.statusDanger;
  const button = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={{ padding: 10, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: fg }}>{label}</Text></Pressable>;
  const rows = ready && !list.isError && list.data?.state === "available" ? list.data.items : [];
  const item = ready && !detail.isError && detail.data?.state === "available" ? detail.data.item : undefined;
  const taskLink = item && "paseoAgentId" in item ? item.paseoAgentId : undefined;
  const content = <View style={{ padding: 16, gap: 10 }}>
    <Text accessibilityRole="header" style={{ color: fg, fontSize: 18 }}>{kind === "jobs" ? "Background jobs" : "Pi subagents"}</Text>
    {button("Refresh", () => { void identity.refetch(); if (ready) { void list.refetch(); if (selectedId) void detail.refetch(); } }, identity.isFetching || list.isFetching || detail.isFetching)}
    {identity.isPending ? <Text style={{ color: muted }}>Connecting to this Pi session…</Text> : null}
    {identity.isError ? <Text style={{ color: danger }}>Cannot read the session status. Reconnect or refresh.</Text> : null}
    {!identity.isPending && !identity.isError && !ready ? <Text style={{ color: muted }}>{identity.data?.reason ?? "Read-only harness data unavailable. The Pi extensions and bridge may need reloading."}</Text> : null}
    {ready && list.isPending ? <Text style={{ color: muted }}>Loading…</Text> : null}
    {ready && list.isError ? <Text style={{ color: danger }}>Cannot read this view. The session may have changed; refresh to retry.</Text> : null}
    {ready && list.data ? <Text style={{ color: muted }}>{list.data.stale ? "Retained snapshot" : "Observed state"}{list.data.lastUpdated ? ` · ${list.data.lastUpdated}` : " · update time unavailable"}</Text> : null}
    {ready && list.data?.state !== "available" ? <Text style={{ color: muted }}>{list.data?.message}</Text> : null}
    {ready && list.data?.state === "available" && !rows.length ? <Text style={{ color: muted }}>No {kind === "jobs" ? "background jobs" : "native subagent tasks"} in this session.</Text> : null}
    {rows.map(row => {
      const id = "jobId" in row ? row.jobId : row.taskId;
      const label = "jobId" in row ? `${row.name ?? row.jobId} · ${row.status} · ${elapsed(row.createdAt, ["starting", "running"].includes(row.status) ? null : row.updatedAt)}${row.observationOnly ? " · observation only" : ""}` : `${row.title} · ${row.status} · attempt ${row.attempt}`;
      return <View key={id}>{button(label, () => select({ id, session: session!, epoch: epoch! }))}</View>;
    })}
    {selectedId && ready ? <View style={{ gap: 8 }}>
      <Text style={{ color: fg }}>{kind === "jobs" ? "Output" : "Report"}: {selectedId}</Text>
      {detail.isPending ? <Text style={{ color: muted }}>Loading selected item…</Text> : null}
      {detail.isError ? <Text style={{ color: danger }}>Selected item unavailable. Refresh to retry.</Text> : null}
      {!detail.isPending && !detail.isError && !item ? <Text style={{ color: muted }}>{detail.data?.message ?? "No retained output or report is available."}</Text> : null}
      {item ? <><Text style={{ color: muted }}>{item.stale ? "Retained snapshot" : "Observed data"}{item.lastUpdated ? ` · ${item.lastUpdated}` : ""}{item.truncated ? " · truncated" : ""}</Text><Text selectable style={{ color: fg }}>{item.text || "No output or answer recorded yet."}</Text></> : null}
      {taskLink && navigation?.openAgent ? button("Open child chat", () => navigation.openAgent({ agentId: taskLink, serverId: host.id })) : null}
      {button("Close detail", () => select(null))}
    </View> : null}
  </View>;
  return embedded ? content : <ScrollView style={{ flex: 1 }}>{content}</ScrollView>;
}
