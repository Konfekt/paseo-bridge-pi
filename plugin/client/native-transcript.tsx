/*
 * Adapted from actual Paseo v0.12.0 component logic (getpaseo/paseo,
 * cafe4b01c8522ff39560241c5deb01427dc8dc5b):
 * - packages/app/src/agent-stream/turn-footer.tsx:115-154,224-240:
 *   RunningTurnFooter/WorkingIndicator structure and metrics.
 * - packages/app/src/agent-stream/strategy-native.tsx:636: inverted-list bottom threshold.
 * - packages/app/src/components/message.tsx:868-994,1866-2175,2210-2397:
 *   ExpandableBadge dimensions/interaction and ToolCall presentation structure.
 * Paseo's private Unistyles, protocol presentation package, detail sheets and icon
 * components are intentionally replaced by the public plugin Icon and local safe
 * summaries. See ../licenses/PASEO-APACHE-2.0.txt.
 */
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";

function toolPresentation(name: string, argumentsValue: unknown): { label: string; summary?: string; icon: string } {
  const args = argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue) ? argumentsValue as Record<string, unknown> : {};
  const first = (...keys: string[]) => keys.map(key => args[key]).find(value => typeof value === "string" && value.trim()) as string | undefined;
  const tool = name.toLowerCase();
  if (["bash", "shell", "terminal", "run", "exec"].includes(tool)) return { label: "Shell", summary: first("command", "cmd", "script"), icon: "SquareTerminal" };
  if (["read", "cat", "open"].includes(tool)) return { label: "Read", summary: first("filePath", "path", "file"), icon: "Eye" };
  if (["edit", "write", "apply_patch"].includes(tool)) return { label: tool === "edit" ? "Edit" : "Write", summary: first("filePath", "path", "file"), icon: "Pencil" };
  if (["grep", "rg", "find", "search"].includes(tool)) return { label: "Search", summary: first("query", "pattern", "path"), icon: "Search" };
  if (["task", "task_outcome", "subagent"].includes(tool)) return { label: tool === "task" ? "Task" : name.replace(/[_-]+/g, " ").replace(/^./, c => c.toUpperCase()), summary: first("description", "task", "summary"), icon: "Bot" };
  if (tool === "thinking") return { label: "Thinking", icon: "Brain" };
  if (tool === "fetch" || tool === "web_search") return { label: "Search", summary: first("url", "query"), icon: "Search" };
  return { label: name.replace(/[._-]+/g, " ").replace(/^./, c => c.toUpperCase()), summary: first("command", "path", "query", "description"), icon: "Wrench" };
}

export function NativeToolBadge({ name, status, summary, argumentsValue, details, colors, expanded, onToggle }: {
  name: string; status: "running" | "completed" | "failed" | "unknown"; summary?: string; argumentsValue?: unknown; details: string; colors: any; expanded: boolean; onToggle(): void;
}) {
  const presentation = toolPresentation(name, argumentsValue);
  const label = presentation.label;
  const subtitle = summary ?? presentation.summary;
  return <View style={{ alignSelf: "stretch", marginHorizontal: -13 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Tool ${label}${subtitle ? ` · ${subtitle}` : ""} · ${status}`} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={onToggle}
      style={{ flexDirection: "row", alignItems: "center", borderRadius: 8, borderWidth: 1, borderColor: expanded ? colors.border : "transparent", borderBottomLeftRadius: expanded ? 0 : 8, borderBottomRightRadius: expanded ? 0 : 8, backgroundColor: expanded ? colors.surface1 : "transparent", paddingHorizontal: 8, paddingVertical: 4 }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", marginRight: 4 }}>
        <Icon name={expanded ? "ChevronDown" : status === "failed" ? "TriangleAlert" : presentation.icon} size={12} color={status === "failed" ? colors.statusDanger : colors.foregroundMuted} />
      </View>
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 14, flexShrink: 0 }}>{label}</Text>
      {subtitle ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 14, marginLeft: 8, flexShrink: 1, minWidth: 0 }}>{subtitle}</Text> : null}
      <View style={{ flex: 1 }} />
    </Pressable>
    {expanded ? <View style={{ borderWidth: 1, borderTopWidth: 0, borderColor: colors.border, borderBottomLeftRadius: 8, borderBottomRightRadius: 8, padding: 8, backgroundColor: colors.surface1 }}>
      <Text selectable style={{ color: colors.foreground, fontFamily: "monospace", fontSize: 12, lineHeight: 17 }}>{details}</Text>
    </View> : null}
  </View>;
}

/** Same compact 24px inline row as Paseo's RunningTurnFooter/WorkingIndicator. */
export function NativeRunningTurnFooter({ color }: { color: string }) {
  return <View testID="turn-working-indicator" style={{ height: 24, flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 12, marginTop: 13, paddingBottom: 16 }}>
    <View style={{ marginLeft: -2 }}><ActivityIndicator accessibilityLabel="Assistant is working" size="small" color={color} /></View>
  </View>;
}
