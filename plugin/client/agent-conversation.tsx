import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView as NativeScrollView } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import { Metadata, NativeButton } from "./presentation";
import { NativeRunningTurnFooter, NativeToolBadge } from "./native-transcript";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { harnessSubagentConversationRpc } from "../shared/harness-readonly";
import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { harnessStatusRpc } from "../shared/harness-readonly";
import { independentAgentOpenRpc } from "../shared/independent-agents";

export type AgentConversationTarget = {
  hostId: string; agentId: string; workspaceId: string; sessionId: string;
  taskId: string; childId: string; attempt: number; runtimeId: string | null; title: string;
};

export function WorkerConversation({ target, epoch, colors, platform }: {
  target: AgentConversationTarget; epoch: string; colors: any; platform: any;
}) {
  const load = useRpc(harnessSubagentConversationRpc);
  const [cursor, setCursor] = useState<number | undefined>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const scroll = useRef<NativeScrollView | null>(null);
  const following = useRef(true);
  const conversation = useQuery({
    queryKey: ["worker-conversation", target.hostId, target.agentId, target.workspaceId, target.sessionId, epoch, target.taskId, target.childId, target.attempt, target.runtimeId, cursor],
    queryFn: () => load({ agentId: target.agentId, workspaceId: target.workspaceId,
      expectedSessionId: target.sessionId, expectedRuntimeEpoch: epoch,
      taskId: target.taskId, childId: target.childId, attempt: target.attempt, runtimeId: target.runtimeId, cursor }),
    refetchInterval: 1200, refetchOnReconnect: true,
  });
  const item = !conversation.isError && conversation.data?.state === "available" ? conversation.data.item : undefined;
  const liveTools = [...new Map((item?.liveEvents ?? []).map(event => [event.toolCallId, event])).values()];
  useEffect(() => { if (following.current) scroll.current?.scrollToEnd({ animated: false }); }, [item?.liveSequence, item?.liveText, item?.messages.length, item?.liveEvents?.length]);
  return <View testID="work-agent-conversation" style={{ gap: 8 }}>
    {conversation.isPending ? <Metadata colors={colors}>Loading conversation…</Metadata> : null}
    {conversation.isError ? <><Metadata colors={colors}>Conversation unavailable. Retrying automatically.</Metadata><NativeButton colors={colors} label="Retry conversation" onPress={() => { void conversation.refetch(); }} /></> : null}
    {!conversation.isPending && !conversation.isError && !item ? <Metadata colors={colors}>{conversation.data?.message ?? "No retained conversation is available."}</Metadata> : null}
    {item ? <View style={{ maxHeight: 320, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface0, overflow: "hidden" }}>
      <ScrollView ref={scroll} nestedScrollEnabled style={{ maxHeight: 320 }} contentContainerStyle={{ padding: 12, gap: 12 }}
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; following.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 48; }}
        scrollEventThrottle={100} onContentSizeChange={() => { if (following.current) scroll.current?.scrollToEnd({ animated: false }); }}>
        {item.messages.map(message => <View key={message.id} style={{ gap: 6 }}>
          {message.role === "assistant" ? null : <Metadata colors={colors}>{message.role}</Metadata>}
          {message.text ? <Text selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{message.text}</Text> : null}
          {message.parts?.map(part => part.type === "toolCall" ? <NativeToolBadge key={`${message.id}:${part.id}`} name={part.name} status={part.status ?? "unknown"} details={JSON.stringify(part.arguments, null, 2)} colors={colors} expanded={!!expanded[part.id]} onToggle={() => setExpanded(current => ({ ...current, [part.id]: !current[part.id] }))} /> : null)}
          {message.truncated ? <Metadata colors={colors}>[truncated]</Metadata> : null}
        </View>)}
        {item.liveText ? <View style={{ gap: 6 }}><Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{item.liveText}</Text></View> : null}
        {liveTools.map(event => <NativeToolBadge key={`live:${event.toolCallId}`} name={event.name} status={event.status ?? "running"} details={event.arguments === undefined ? event.result ?? "" : JSON.stringify(event.arguments, null, 2)} colors={colors} expanded={!!expanded[event.toolCallId]} onToggle={() => setExpanded(current => ({ ...current, [event.toolCallId]: !current[event.toolCallId] }))} />)}
        {item.execution === "running" ? <NativeRunningTurnFooter color={colors.foregroundMuted} /> : null}
        {!item.messages.length && !item.liveText ? <Metadata colors={colors}>No messages recorded yet.</Metadata> : null}
      </ScrollView>
    </View> : null}
    {item?.truncated ? <Metadata colors={colors}>Conversation excerpt</Metadata> : null}
    {item?.nextCursor != null ? <NativeButton colors={colors} label="Next messages" onPress={() => setCursor(item.nextCursor)} /> : null}
    {cursor != null ? <NativeButton colors={colors} label="First messages" onPress={() => setCursor(undefined)} /> : null}
  </View>;
}

/** Public plugin screens expose native navigation; composer popovers do not.
 * Native openAgent pops/dismisses this transient screen back to the workspace,
 * opening a normal agent tab rather than leaving a plugin log tab behind.
 */
function OpenIndependentConversation({ params, navigation, theme }: PluginScreenProps) {
  const opened = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string>();
  const agentId = params.agentId;
  const workspaceId = params.workspaceId;
  const serverId = params.serverId;
  const open = () => {
    if (workspaceId) {
      if (typeof workspaceId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(workspaceId) || (serverId != null && (typeof serverId !== "string" || !serverId || serverId.length > 1024))) { setError("Invalid workspace identity."); return; }
      if (!navigation?.openWorkspace) { setError("This Paseo client cannot navigate to the workspace."); return; }
      try { navigation.openWorkspace({ workspaceId, ...(typeof serverId === "string" ? { serverId } : {}) }); }
      catch { setError("Could not open the workspace."); }
      return;
    }
    if (!agentId || !/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) { setError("Invalid conversation identity."); return; }
    if (!navigation?.openAgent) { setError("This Paseo client cannot navigate to the conversation. It is available in the agent list."); return; }
    try { navigation.openAgent({ agentId }); }
    catch { setError("Could not open the conversation."); }
  };
  useEffect(() => {
    const target = JSON.stringify([agentId, workspaceId, serverId]);
    if (opened.current === target) return;
    opened.current = target;
    setError(undefined);
    open();
  }, [agentId, workspaceId, serverId, navigation]);
  return <View style={{ flex: 1, padding: 16, gap: 12 }}>
    <Metadata colors={theme.colors} style={{ color: error ? theme.colors.statusWarning : theme.colors.foregroundMuted }}>{error ?? (workspaceId ? "Opening workspace…" : "Opening conversation…")}</Metadata>
    {error && (navigation?.openAgent || navigation?.openWorkspace) ? <SettingsAction label="" actionLabel={workspaceId ? "Open workspace" : "Open conversation"} onPress={open} /> : null}
  </View>;
}

export function createAgentConversationTabs(client: PluginClientContext) {
  const pending = new Map<string, Promise<void>>();
  let disposed = false;
  let selectedTarget: string | undefined;
  const disposeScreen = client.addScreen({ id: "independent-conversation", title: "Conversation", Component: OpenIndependentConversation });
  return {
    openWorkspace(target: { workspaceId: string; serverId?: string }): void {
      if (disposed) return;
      selectedTarget = `workspace:${target.workspaceId}`;
      client.openScreen({ screenId: "independent-conversation", params: { workspaceId: target.workspaceId, ...(target.serverId ? { serverId: target.serverId } : {}) } });
    },
    open(target: AgentConversationTarget, isCurrent: () => boolean = () => true): Promise<void> {
      if (disposed) return Promise.reject(new Error("Conversation navigation is unavailable"));
      const key = JSON.stringify(target);
      selectedTarget = key;
      const existing = pending.get(key);
      if (existing) return existing;
      const operation = (async () => {
        const identity = await client.rpc(harnessStatusRpc, { agentId: target.agentId, workspaceId: target.workspaceId });
        if (disposed || !isCurrent()) throw new Error("The source conversation is no longer selected.");
        if (!identity.available || identity.sessionId !== target.sessionId || !identity.runtimeEpoch)
          throw new Error("The source session is unavailable or has changed.");
        const created = await client.rpc(independentAgentOpenRpc, {
          agentId: target.agentId, workspaceId: target.workspaceId,
          expectedSessionId: target.sessionId, expectedRuntimeEpoch: identity.runtimeEpoch,
          taskId: target.taskId, childId: target.childId, attempt: target.attempt, runtimeId: target.runtimeId,
        });
        if (!disposed && isCurrent() && selectedTarget === key) client.openScreen({ screenId: "independent-conversation", params: { agentId: created.agentId } });
      })().finally(() => { pending.delete(key); });
      pending.set(key, operation);
      return operation;
    },
    dispose() { disposed = true; disposeScreen(); },
  };
}
