import { useMutation, useQuery } from "@tanstack/react-query";
import {
  type PluginButtonContentProps,
  type PluginButtonRegistration,
  type PluginClientContext,
  useRpc,
} from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Metadata, NativeRow, SectionHeading, Surface } from "./presentation";
import { permissionGateSetRpc, permissionGateStatusRpc } from "../shared/permission-gate";
import { gateControlsDisabled, gateLabel, hasNativeAccessModes } from "../shared/ui-state";
import { mayApplyAsyncResult } from "../shared/lifecycle";
import { isDormantIndependentAgent } from "../shared/independent-state";

type Agent = { id: string; workspaceId?: string | null; provider?: string; archivedAt?: string | null; availableModes?: { id: string }[] };
type Entry = { agent: Agent; registration: PluginButtonRegistration; sequence: number };

export function contributeClient(client: PluginClientContext) {
  const entries = new Map<string, Entry>();
  let stopped = false;
  const lifetime = new AbortController();
  const remove = (agentId: string) => {
    const entry = entries.get(agentId);
    if (!entry) return;
    entry.sequence++;
    entry.registration.remove();
    entries.delete(agentId);
  };
  const refreshLabel = async (entry: Entry) => {
    const sequence = ++entry.sequence;
    try {
      const status = await client.rpc(permissionGateStatusRpc, { agentId: entry.agent.id, workspaceId: entry.agent.workspaceId! });
      if (!mayApplyAsyncResult({ stopped, aborted: lifetime.signal.aborted, sequence, currentSequence: entry.sequence, current: entries.get(entry.agent.id), expected: entry })) return;
      entry.registration.update({
        label: gateLabel(status),
        title: status.available ? gateLabel(status) : "Access mode unavailable · press to retry",
      });
    } catch {
      if (!mayApplyAsyncResult({ stopped, aborted: lifetime.signal.aborted, sequence, currentSequence: entry.sequence, current: entries.get(entry.agent.id), expected: entry })) return;
      entry.registration.update({ label: "Access unavailable", title: "Access mode unavailable · press to retry" });
    }
  };
  const register = (agent: Agent) => {
    if (agent.provider !== "pi" || agent.archivedAt || !agent.workspaceId || hasNativeAccessModes(agent.availableModes) || isDormantIndependentAgent(agent)) { remove(agent.id); return; }
    if (stopped) return;
    const existing = entries.get(agent.id);
    if (existing && existing.agent.workspaceId === agent.workspaceId) {
      existing.agent = agent;
      return;
    }
    remove(agent.id);
    const registration = client.addComposerPill({
      id: "permission-gate",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Access mode · checking",
        icon: "Shield",
        label: "Access · …",
        behavior: { kind: "popover", Content: PermissionGatePopover },
      },
    });
    const entry: Entry = { agent, registration, sequence: 0 };
    entries.set(agent.id, entry);
    void refreshLabel(entry);
  };
  const timer = setInterval(() => {
    for (const entry of entries.values()) void refreshLabel(entry);
  }, 5000);
  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (stopped) return;
    subscription.subscribe({
      snapshot: ({ entries: agents }) => {
        const current = new Set(agents.map(({ agent }) => agent.id));
        for (const id of [...entries.keys()]) if (!current.has(id)) remove(id);
        for (const { agent } of agents) register(agent);
      },
      update: (message) => {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "remove") remove(update.agentId);
        else register(update.agent);
      },
    });
  }).catch((error) => { if (!stopped) console.error("Permission gate agent observation failed", error); });
  return () => {
    stopped = true;
    lifetime.abort();
    clearInterval(timer);
    for (const id of [...entries.keys()]) remove(id);
  };
}

function PermissionGatePopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return <View />;
  return <PermissionGateControls workspaceId={props.workspaceId} agentId={props.agentId} theme={props.theme} />;
}

function PermissionGateControls({ workspaceId, agentId, theme }: { workspaceId: string; agentId: string; theme: PluginButtonContentProps["theme"] }) {
  const statusCall = useRpc(permissionGateStatusRpc);
  const setCall = useRpc(permissionGateSetRpc);
  const [message, setMessage] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["permission-gate", agentId, workspaceId],
    queryFn: () => statusCall({ agentId, workspaceId }),
    refetchInterval: 5000,
    refetchOnReconnect: true,
    staleTime: 4000,
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => {
      const sessionId = status.data?.sessionId;
      const runtimeEpoch = status.data?.runtimeEpoch;
      if (!status.data?.available || !sessionId || !runtimeEpoch) throw new Error("Permission state unavailable. Refresh before changing it.");
      return setCall({ agentId, workspaceId, expectedSessionId: sessionId, expectedRuntimeEpoch: runtimeEpoch, enabled });
    },
    onSuccess: async () => {
      setMessage(null);
      await status.refetch();
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "Permission change failed.");
      void status.refetch();
    },
  });
  useEffect(() => { setMessage(null); }, [agentId, workspaceId]);

  const available = status.data?.available === true;
  const enabled = status.data?.enabled;
  const disabled = !status.data?.sessionId || !status.data?.runtimeEpoch || gateControlsDisabled({
    available, enabled: enabled ?? null, fetching: status.isFetching, stale: status.isStale,
    error: status.isError, pending: mutation.isPending || status.isPending,
  });
  const danger = theme.colors.statusDanger;
  return (
    <View style={{ gap: 12 }}>
      <SectionHeading colors={theme.colors} title="Access mode" />
      <Surface colors={theme.colors} padded>
        {status.isError ? <Metadata colors={theme.colors} alert style={{ color: danger }}>Could not read permission state. Controls are disabled.</Metadata> : null}
        {status.isPending ? <Metadata colors={theme.colors}>Checking this agent…</Metadata> : null}
        {status.data && !status.data.available ? <Metadata colors={theme.colors}>{status.data.reason ?? "Permission control unavailable."}</Metadata> : null}
        {available ? <Metadata colors={theme.colors}>Applies to this agent and its children.</Metadata> : null}
        <Metadata colors={theme.colors}>Sandbox and authorization policy stay active.</Metadata>
        <NativeRow colors={theme.colors} title={`${enabled === true ? "✓ " : ""}Dangerous ask`} detail="Ask when an action needs approval." disabled={disabled || enabled === true} selected={enabled === true} onPress={() => mutation.mutate(true)} />
        <NativeRow colors={theme.colors} title={`${enabled === false ? "✓ " : ""}Full access`} detail="Turn off approval prompts." disabled={disabled || enabled === false} selected={enabled === false} onPress={() => mutation.mutate(false)} />
        {mutation.isPending ? <Metadata colors={theme.colors}>Applying…</Metadata> : null}
        {message ? <Metadata colors={theme.colors} alert style={{ color: danger }}>{message}</Metadata> : null}
      </Surface>
    </View>
  );
}
