import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, Modal, ScrollView, TextInput, copyText } from "@getpaseo/plugin/client/react-native";
import {
  useRpc, type PluginAgentPanelProps, type PluginClientContext,
  type PluginButtonRegistration, type PluginButtonContentProps, type PluginButtonIconProps, type PluginButtonBehavior,
} from "@getpaseo/plugin/client";
import { isDormantIndependentAgent } from "../shared/independent-state";
import { Metadata, OutputWell, Surface } from "./presentation";
import { btwControlRpc, btwStatusRpc, type BtwRequest } from "../shared/btw";

type Memory = {
  generation: number;
  selected?: string;
  binding?: string;
  pendingQuestion?: string;
  drafts: Record<string, { text: string; revision: number }>;
  busy: boolean;
  uncertain: boolean;
  message?: string;
  sequence: number;
  refreshed: number;
  failedAt: number;
};
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}
type ChatProps = Pick<PluginAgentPanelProps, "host" | "workspaceId" | "agentId" | "theme" | "layout"> & { expanded?: boolean };
export function BtwPanel(props: ChatProps) {
  return <BtwView key={JSON.stringify([props.host.id, props.workspaceId, props.agentId])} {...props} />;
}
function BtwPopover(props: PluginButtonContentProps) {
  return props.context === "agent" ? <BtwPanel {...props} /> : null;
}
function createMobileChatState() {
  let open = false;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => open,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setOpen: (value: boolean) => { if (open !== value) { open = value; for (const listener of listeners) listener(); } },
  };
}
function BtwButtonIcon(props: PluginButtonIconProps & {
  configure: (behavior: PluginButtonBehavior) => void;
  modal: ReturnType<typeof createMobileChatState>;
}) {
  // Button actions briefly replace their icon with a spinner. Keep modal state outside that icon lifetime.
  const open = useSyncExternalStore(props.modal.subscribe, props.modal.getSnapshot, props.modal.getSnapshot);
  const setOpen = props.modal.setOpen;
  const mobile = props.layout.compact || props.layout.platform !== "web";
  useEffect(() => {
    props.configure(mobile ? { kind: "action", onPress: () => setOpen(true) }
      : { kind: "popover", Content: BtwPopover });
    if (!mobile) setOpen(false);
  }, [mobile, props.configure, setOpen]);
  return <>
    <Icon name="MessagesSquare" size={props.size} color={props.color} />
    {mobile && open && props.context === "agent" ? (
      <Modal title="" open={open} onOpenChange={setOpen}>
        <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ flex: 1, padding: 0, gap: 0 }}>
          <BtwPanel {...props} expanded />
        </Modal.Content>
      </Modal>
    ) : null}
  </>;
}
function BtwView({ host, workspaceId, agentId, theme, layout, expanded = false }: ChatProps) {
  const status = useRpc(btwStatusRpc), control = useRpc(btwControlRpc);
  const [saved] = useState<Memory>(() => ({ generation: 0, drafts: {}, busy: false, uncertain: false, sequence: 0, refreshed: 0, failedAt: 0 }));
  const [instanceId] = useState(uuid);
  const [, redraw] = useState(0);
  const [copied, setCopied] = useState<string>();
  const scroll = useRef<any>(null);
  const closed = useRef(false);
  const pending = useRef<Promise<unknown> | undefined>(undefined);
  const discard = useRef<(() => Promise<unknown>) | undefined>(undefined);
  function discardOwnedThread() {
    const remove = discard.current, inflight = pending.current;
    discard.current = undefined;
    pending.current = undefined;
    if (remove) void (async () => {
      try { await inflight; } catch { /* Still discard a possibly accepted request. */ }
      try { await remove(); } catch (error) { console.warn("BTW dismissal cleanup unavailable", error); }
    })();
  }
  useEffect(() => {
    closed.current = false;
    return () => { closed.current = true; discardOwnedThread(); };
  }, []);
  const refreshView = () => { if (!closed.current) redraw(n => n + 1); };
  const selected = saved.selected;
  const query = useQuery({
    queryKey: ["pi-btw", host.id, workspaceId, agentId, instanceId, selected ?? ""],
    queryFn: async () => {
      const sequence = ++saved.sequence, generation = saved.generation;
      const data = await status({ agentId, workspaceId, ...(selected ? { threadId: selected } : {}) });
      if (closed.current || generation !== saved.generation) return data;
      if (data.available && data.snapshot) {
        const binding = JSON.stringify([data.sessionId, data.runtimeEpoch, data.snapshot.serviceEpoch]);
        if (saved.binding && saved.binding !== binding) {
          const previous = JSON.parse(saved.binding), threadId = saved.selected;
          // A new transport may still own the same engine and thread. Remove only that exact thread.
          if (threadId && previous[0] === data.sessionId && previous[2] === data.snapshot.serviceEpoch) {
            const sessionId = data.sessionId!, serviceEpoch = data.snapshot.serviceEpoch;
            discard.current = () => control({ agentId, workspaceId, expectedRuntimeEpoch: data.runtimeEpoch!,
              request: { operation: "remove", sessionId, serviceEpoch, threadId, requestId: uuid() } });
          }
          discardOwnedThread();
          saved.generation += 1;
          saved.selected = undefined;
          saved.pendingQuestion = undefined;
          saved.drafts = {};
          saved.busy = false;
          saved.uncertain = false;
          saved.message = undefined;
          saved.failedAt = 0;
          setCopied(undefined);
          refreshView();
        }
        saved.binding = binding;
        saved.refreshed = Math.max(saved.refreshed, sequence);
      }
      return data;
    },
    gcTime: 0,
    refetchInterval: query => query.state.data?.snapshot?.threads.find(t => t.id === selected)?.state === "running" ? 1000 : 5000,
    refetchOnReconnect: true,
    staleTime: 0,
  });
  const data = query.data, snap = data?.snapshot;
  const binding = data?.available && snap
    ? JSON.stringify([data.sessionId, data.runtimeEpoch, snap.serviceEpoch]) : undefined;
  const current = !!binding && binding === saved.binding && !query.isError;
  const thread = current ? snap?.threads.find(t => t.id === selected) : undefined;
  const draftKey = selected ?? "new", draft = saved.drafts[draftKey]?.text ?? "";
  const blocked = !current || saved.busy || saved.uncertain;
  const canSend = !blocked && !!draft.trim() && thread?.state !== "running" && (!selected || !!thread);
  const colors = theme.colors;
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
      disabled={disabled} onPress={action}
      style={{ minHeight: 36, paddingHorizontal: 8, justifyContent: "center", opacity: disabled ? 0.45 : 1 }}>
      <Text style={{ color: colors.accent }}>{label}</Text>
    </Pressable>
  );
  const question = (text: string) => (
    <View style={{ alignSelf: "flex-end", maxWidth: "92%", backgroundColor: colors.surface1, borderRadius: 12, padding: 10 }}>
      <Text selectable style={{ color: colors.foreground, lineHeight: 21 }}>{text}</Text>
    </View>
  );
  async function mutate(operation: BtwRequest["operation"]) {
    if (blocked || saved.busy || saved.uncertain || !snap || !data?.runtimeEpoch || !data.sessionId) return;
    const generation = saved.generation;
    const question = draft.trim(), submitted = saved.drafts[draftKey];
    if ((operation === "start" || operation === "send") && (!question || thread?.state === "running")) return;
    const threadId = operation === "start" ? uuid() : selected;
    if (!threadId) return;
    const base = { sessionId: data.sessionId, serviceEpoch: snap.serviceEpoch, requestId: uuid(), threadId };
    const request: BtwRequest = operation === "start"
      ? { ...base, operation, question, model: snap.defaultModel, context: "recent" }
      : operation === "send" ? { ...base, operation, question } : { ...base, operation };
    saved.busy = true;
    saved.message = undefined;
    if (operation === "start" || operation === "send") saved.pendingQuestion = question;
    if (operation === "start") saved.selected = threadId;
    refreshView();
    discard.current = () => control({ agentId, workspaceId, expectedRuntimeEpoch: data.runtimeEpoch!,
      request: { ...base, operation: "remove", requestId: uuid() } });
    try {
      pending.current = control({ agentId, workspaceId, expectedRuntimeEpoch: data.runtimeEpoch, request });
      await pending.current;
      if (generation !== saved.generation || closed.current) return;
      if ((operation === "start" || operation === "send") && submitted && saved.drafts[draftKey]?.revision === submitted.revision)
        saved.drafts[draftKey] = { text: "", revision: submitted.revision + 1 };
      if (operation === "remove" && saved.selected === threadId) saved.selected = undefined;
    } catch {
      if (generation !== saved.generation || closed.current) return;
      saved.uncertain = true;
      saved.failedAt = saved.sequence;
      saved.message = "The action may have completed. Refresh and review this chat before continuing.";
    } finally {
      if (generation === saved.generation && !closed.current) {
        saved.busy = false;
        refreshView();
        void query.refetch();
      }
    }
  }
  return (
    <View style={expanded ? { flex: 1, minHeight: 0, width: "100%", backgroundColor: colors.surface0 }
      : { width: 340, maxWidth: "100%", height: 400, backgroundColor: colors.surface0 }}>
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 14 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd?.({ animated: false })}>
        {query.isPending ? <Metadata colors={colors}>Connecting…</Metadata> : null}
        {query.isError ? <Metadata colors={colors} style={{ color: colors.statusWarning }}>Connection unavailable.</Metadata> : null}
        {!query.isPending && !query.isError && !data?.available ? <Metadata colors={colors}>Reload Pi to enable BTW.</Metadata> : null}
        {thread?.turns.map((turn, index) => <View key={`${thread.id}:${index}`} style={{ gap: 12 }}>
          {question(turn.question)}
          <OutputWell colors={colors} text={turn.answer} platform={layout.platform} />
          <Pressable accessibilityRole="button" accessibilityLabel="Copy response"
            style={{ alignSelf: "flex-start", padding: 8 }} onPress={() => {
              const generation = saved.generation;
              void copyText(turn.answer).then(() => { if (!closed.current && generation === saved.generation) setCopied(`${thread.id}:${index}`); }, () => {
                if (closed.current || generation !== saved.generation) return;
                if (!saved.uncertain) saved.message = "Could not copy. Select the text to copy it.";
                refreshView();
              });
            }}>
            <Icon name={copied === `${thread.id}:${index}` ? "Check" : "Copy"} size={16} color={colors.foregroundMuted} />
          </Pressable>
        </View>)}
        {thread?.state === "running" ? <View style={{ gap: 12 }}>
          {question(saved.pendingQuestion ?? thread.question)}
          <OutputWell colors={colors} text={thread.partial || "Thinking…"} platform={layout.platform} />
        </View> : null}
        {current && selected && !thread ? <Text style={{ color: colors.foregroundMuted }}>{saved.busy || query.isFetching ? "Loading…" : "This chat is no longer available. Dismiss and reopen BTW to start again."}</Text> : null}
        {thread?.state === "cancelled" ? <Text style={{ color: colors.foregroundMuted }}>Response stopped.</Text> : null}
        {thread?.error ? <Metadata colors={colors} style={{ color: colors.statusWarning }}>{thread.error}</Metadata> : null}
        {saved.message ? <Metadata colors={colors} style={{ color: saved.uncertain ? colors.statusWarning : colors.foregroundMuted }}>{saved.message}</Metadata> : null}
        {saved.uncertain ? <View>
          {button("Refresh", () => void query.refetch(), query.isFetching)}
          {button("I reviewed the refreshed chat", () => { saved.uncertain = false; saved.message = undefined; refreshView(); },
            saved.busy || saved.refreshed <= saved.failedAt || query.isError || query.isFetching)}
        </View> : null}
      </ScrollView>
      <Surface colors={colors} style={{ margin: 10, position: "relative" }}>
        <TextInput accessibilityLabel="BTW message" placeholder="Ask a side question…" placeholderTextColor={colors.foregroundMuted} multiline maxLength={8000}
          editable={!blocked && thread?.state !== "running"} value={draft}
          onKeyPress={layout.platform === "web" ? event => {
            const key = event.nativeEvent as typeof event.nativeEvent & { shiftKey?: boolean; isComposing?: boolean; keyCode?: number; which?: number; repeat?: boolean };
            if (key.key !== "Enter" || key.shiftKey || key.isComposing || key.keyCode === 229 || key.which === 229) return;
            event.preventDefault();
            event.stopPropagation();
            if (canSend && !key.repeat) void mutate(selected ? "send" : "start");
          } : undefined}
          onChangeText={text => { saved.drafts[draftKey] = { text, revision: (saved.drafts[draftKey]?.revision ?? 0) + 1 }; refreshView(); }}
          style={{ color: colors.foreground, backgroundColor: "transparent", borderWidth: 0,
            borderRadius: 10, padding: 10, paddingBottom: 44, minHeight: 88, maxHeight: 150 }} />
        <View style={{ position: "absolute", bottom: 8, right: 8 }}>
          <Pressable accessibilityRole="button"
            accessibilityLabel={thread?.state === "running" ? "Stop response" : "Send message"}
            accessibilityState={{ disabled: thread?.state === "running" ? blocked : !canSend }}
            disabled={thread?.state === "running" ? blocked : !canSend}
            onPress={() => void mutate(thread?.state === "running" ? "cancel" : selected ? "send" : "start")}
            style={{ width: 28, height: 28, borderRadius: 999, marginLeft: 4,
              alignItems: "center", justifyContent: "center",
              backgroundColor: thread?.state === "running" ? colors.statusDanger : colors.accent,
              opacity: (thread?.state === "running" ? blocked : !canSend) ? 0.5 : 1 }}>
            {thread?.state === "running"
              ? <View style={{ width: 12, height: 12, borderRadius: 1, backgroundColor: "white" }} />
              : <Icon name="ArrowUp" size={layout.platform === "web" ? 16 : 20} color={colors.accentForeground} />}
          </Pressable>
        </View>
      </Surface>
    </View>
  );
}

export function contributeBtw(client: PluginClientContext) {
  const entries = new Map<string, { workspace: string; button: PluginButtonRegistration }>();
  const controller = new AbortController();
  let stopped = false;
  const remove = (id: string) => { entries.get(id)?.button.remove(); entries.delete(id); };
  const register = (agent: { id: string; workspaceId?: string | null; provider?: string; archivedAt?: string | null }) => {
    if (stopped) return;
    if (agent.provider !== "pi" || agent.archivedAt || !agent.workspaceId || isDormantIndependentAgent(agent)) { remove(agent.id); return; }
    if (entries.get(agent.id)?.workspace === agent.workspaceId) return;
    remove(agent.id);
    const workspaceId = agent.workspaceId;
    let button: PluginButtonRegistration | undefined;
    const configure = (behavior: PluginButtonBehavior) => button?.update({ behavior });
    const modal = createMobileChatState();
    button = client.addComposerPill({ id: "pi-btw", agentId: agent.id, workspaceId,
      button: { label: "btw", title: "btw", icon: props => <BtwButtonIcon {...props} configure={configure} modal={modal} />,
        behavior: { kind: "popover", Content: BtwPopover } },
    });
    entries.set(agent.id, { workspace: workspaceId, button });
  };
  void client.paseo.agents.list({ subscribe: {}, signal: controller.signal }).then(({ subscription }) => {
    if (stopped) return;
    subscription.subscribe({
      snapshot: ({ entries: agents }) => {
        if (stopped) return;
        const ids = new Set(agents.map(({ agent }) => agent.id));
        for (const id of entries.keys()) if (!ids.has(id)) remove(id);
        for (const { agent } of agents) register(agent);
      },
      update: message => {
        if (stopped || message.type !== "agent_update") return;
        if (message.payload.kind === "remove") remove(message.payload.agentId);
        else register(message.payload.agent);
      },
    });
  }).catch(error => { if (!stopped) console.error("BTW subscription unavailable", error); });
  return () => {
    stopped = true;
    controller.abort();
    for (const id of entries.keys()) remove(id);
  };
}
