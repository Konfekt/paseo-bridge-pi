import { useState } from "react";
import { Text, View } from "react-native";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { z } from "zod";
import type { workflowSnapshotSchema } from "../shared/workflows";
import { Metadata, NativeButton, type PresentationColors } from "./presentation";
type Snapshot = z.infer<typeof workflowSnapshotSchema>;

/** No migration or execution controls: legacy state belongs to the parent. */
export function LegacyGoals({ goal, completed = [], colors }: {
  goal: Snapshot["goal"]; completed?: Snapshot["completedGoals"]; colors: PresentationColors;
}) {
  const [history, setHistory] = useState(false);
  if (!goal && !completed.length) return null;
  return <SettingsSection title="Legacy parent goals" info="These goals remain in the parent session. They are never copied into a child automatically.">
    {goal ? <SettingsCard><View style={{ padding: 16, gap: 8 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{goal.text}</Text>
      <Metadata colors={colors}>{goal.status.replaceAll("_", " ")} · Parent session</Metadata>
      {goal.tasks?.map((task, index) => <Metadata key={task.id ?? index} colors={colors}>{task.status === "completed" ? "✓" : "○"} {task.text}</Metadata>)}
      {goal.summary ? <Metadata colors={colors}>{goal.summary}</Metadata> : null}
    </View></SettingsCard> : null}
    {completed.length ? <View style={{ gap: 12, paddingTop: goal ? 12 : 0 }}>
      <NativeButton colors={colors} label={history ? "Hide legacy history" : "Legacy history"} onPress={() => setHistory(!history)} style={{ alignSelf: "flex-start", minHeight: 44 }} />
      {history ? <SettingsCard>{completed.map(item => <View key={item.id} style={{ padding: 16, gap: 4 }}>
        <Metadata colors={colors}>{item.status === "completed" ? "Completed" : "Cleared"} · Parent session</Metadata>
        <Text selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{item.text}</Text>
        {item.summary ? <Metadata colors={colors}>{item.summary}</Metadata> : null}
        <Metadata colors={colors}>{item.tasks.filter(task => task.status === "completed").length}/{item.tasks.length} tasks completed</Metadata>
      </View>)}</SettingsCard> : null}
    </View> : null}
  </SettingsSection>;
}
