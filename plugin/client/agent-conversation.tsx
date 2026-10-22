import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import { Metadata } from "./presentation";
import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { harnessStatusRpc } from "../shared/harness-readonly";
import { independentAgentOpenRpc } from "../shared/independent-agents";

export type AgentConversationTarget = {
  hostId: string; agentId: string; workspaceId: string; sessionId: string;
  taskId: string; childId: string; attempt: number; runtimeId: string | null; title: string;
};

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
