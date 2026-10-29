// Copied and adapted from Steve Castaneda's Progress plugin (MIT), revision 7aa34cc.
// Sources: client/{tabs,row,status-badge,time-bar,panel,ticket-dialog,write-up}.tsx.
// See ../licenses/progress-MIT.txt and ../../docs/goals-progress-provenance.md.
import { useState, type ReactNode } from "react";
import { Pressable, Text, View, type PressableProps, type ViewStyle } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { PresentationColors as Colors } from "./presentation";
import type { DelegatedGoal } from "./delegated-goals";

export const goalStatusLabels: Record<DelegatedGoal["status"], string> = {
  paused: "Paused", active: "Working", blocked: "Blocked", usage_limited: "Usage limit reached",
  budget_limited: "Budget reached", complete: "Completed", cleared: "Cleared",
};
export type StoryTab = "write-up" | "timeline" | "activity" | "questions";
export interface TabEntry<Id extends string> { id: Id; label: string; icon?: string | null; count?: number }

// Progress's bottom-rule tab strip. Compact Goals always drops icons/counts so
// all four required labels fit; the workspace's framing remains our own.
export function TabStrip<Id extends string>({ colors, tabs, selected, onSelect, narrow = false }: {
  colors: Colors; tabs: Array<TabEntry<Id>>; selected: Id; onSelect(id: Id): void; narrow?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const compact = narrow || (width > 0 && width < 500);
  return <View accessibilityRole="tablist" onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flexDirection: "row", flexWrap: "wrap", columnGap: compact ? 12 : 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
    {tabs.map(entry => <Tab key={entry.id} colors={colors} narrow={compact} entry={entry} selected={entry.id === selected} onPress={() => onSelect(entry.id)} />)}
  </View>;
}
function Tab<Id extends string>({ colors, narrow, entry, selected, onPress }: { colors: Colors; narrow: boolean; entry: TabEntry<Id>; selected: boolean; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  return <Pressable accessibilityRole="tab" accessibilityLabel={entry.label} accessibilityState={{ selected }} aria-selected={selected} onPress={onPress}
    onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: narrow ? 4 : 6, paddingTop: 8, paddingBottom: 6, minHeight: 44, marginBottom: -1,
      borderBottomWidth: 2, borderBottomColor: selected ? colors.accent : pressed || hovered ? colors.border : "transparent" })}>
    {!narrow && entry.icon ? <Icon name={entry.icon} size={14} color={selected ? colors.accent : colors.foregroundMuted} /> : null}
    <Text style={{ color: selected || hovered ? colors.foreground : colors.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>{entry.label}</Text>
    {!narrow && entry.count !== undefined ? <View style={{ minWidth: 16, paddingHorizontal: 4, borderRadius: 4, alignItems: "center", backgroundColor: colors.surface2 }}>
      <Text style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: 10, lineHeight: 14, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{entry.count}</Text>
    </View> : null}
  </Pressable>;
}
export function PressableRow({ colors, onSurface1 = false, transparentAtRest = true, style, children, ...props }: Omit<PressableProps, "style" | "children"> & {
  colors: Colors; onSurface1?: boolean; transparentAtRest?: boolean; style?: ViewStyle; children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return <Pressable {...props} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} style={({ pressed }) => {
    const tint = onSurface1 ? pressed ? colors.border : hovered ? colors.surface2 : colors.surface1
      : pressed ? colors.surface2 : hovered ? colors.surface1 : "transparent";
    return [style, { backgroundColor: !hovered && !pressed && transparentAtRest ? "transparent" : tint }];
  }}>{children}</Pressable>;
}
export function StatusBadge({ colors, status }: { colors: Colors; status: DelegatedGoal["status"] }) {
  const tone = status === "active" ? { fg: colors.accentForeground, bg: colors.accent, border: colors.accent }
    : status === "complete" ? { fg: colors.statusSuccess, bg: "transparent", border: colors.statusSuccess }
    : status === "blocked" || status === "budget_limited" || status === "usage_limited" ? { fg: colors.statusDanger, bg: "transparent", border: colors.statusDanger }
    : { fg: colors.foregroundMuted, bg: "transparent", border: colors.border };
  return <View style={{ alignSelf: "flex-start", borderWidth: 1, borderColor: tone.border, backgroundColor: tone.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 }}>
    <Text style={{ color: tone.fg, fontSize: 11, lineHeight: 16 }}>{goalStatusLabels[status]}</Text>
  </View>;
}
export function taskCounts(tasks: DelegatedGoal["tasks"]) {
  return { total: tasks.length, completed: tasks.filter(task => task.status === "completed").length, blocked: tasks.filter(task => task.status === "blocked").length };
}
export const taskTones = { completed: "#3d73d5", in_progress: "#779cde", blocked: "#c98279", pending: "#30333f" } as const;
export function TaskBar({ colors, tasks }: { colors: Colors; tasks: DelegatedGoal["tasks"] }) {
  if (!tasks.length) return null;
  const { total, completed, blocked } = taskCounts(tasks);
  const label = `${completed} of ${total} tasks complete${blocked ? ` · ${blocked} blocked` : ""}`;
  return <View style={{ gap: 8 }}>
    <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontVariant: ["tabular-nums"] }}>{label}</Text>
    <View accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: total, now: completed, text: label }} aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed} aria-valuetext={label}
      style={{ height: 4, borderRadius: 2, overflow: "hidden", flexDirection: "row", gap: 2, backgroundColor: colors.surface2 }}>
      {tasks.map(task => <View key={task.id} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ flex: 1, backgroundColor: taskTones[task.status] }} />)}
    </View>
  </View>;
}
export function GoalTicketRow({ colors, goal, title, selected, onPress }: { colors: Colors; goal: DelegatedGoal; title: string; selected: boolean; onPress(): void }) {
  return <PressableRow colors={colors} onSurface1={selected} transparentAtRest={!selected} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ selected }} onPress={onPress}
    style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border, minHeight: 44 }}>
    <View style={{ width: 16, paddingTop: 2, alignItems: "center" }}><Icon name={goal.status === "complete" ? "Check" : goal.status === "active" ? "CirclePlay" : goal.status === "blocked" ? "Ban" : "CirclePause"} size={14} color={goal.status === "blocked" ? colors.statusDanger : colors.foregroundMuted} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text numberOfLines={3} style={{ color: colors.foreground, fontSize: 13, lineHeight: 18 }}>{title}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{goalStatusLabels[goal.status]}{goal.tasks.length ? ` · ${taskCounts(goal.tasks).completed}/${goal.tasks.length} tasks` : ""}</Text>
    </View>
    <View style={{ paddingTop: 2 }}><Icon name="ChevronRight" size={14} color={colors.foregroundMuted} /></View>
  </PressableRow>;
}

// TicketStoryView's log rows, without elapsed-time guesses, inferred links or animation.
export function StoryLog({ colors, entries, timeline = false }: { colors: Colors; entries: Array<{ id: string; at: number; text: string; kind?: string }>; timeline?: boolean }) {
  if (!entries.length) return <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{timeline ? "No recorded timeline yet" : "No progress updates yet"}</Text>;
  return <View>{entries.map(entry => <View key={entry.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: timeline ? 6 : 12, paddingVertical: 6 }}>
    {timeline ? <View style={{ width: 14, alignItems: "center", paddingTop: 3 }}><Icon name={entry.kind === "created" ? "CirclePlus" : entry.kind === "completed" ? "CircleCheck" : entry.kind === "blocked" ? "Ban" : "CircleDot"} size={12} color={entry.kind === "blocked" ? colors.statusDanger : colors.foregroundMuted} /></View> : null}
    <Text selectable style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{entry.text}</Text>
    <Text accessibilityLabel={new Date(entry.at).toLocaleString()} style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 19, fontVariant: ["tabular-nums"] }}>{new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Text>
  </View>)}</View>;
}
