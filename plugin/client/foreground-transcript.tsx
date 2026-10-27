/** Foreground activity uses the same native tool model/badge as retained and
 * live background previews. This adds no control or navigation authority. */
import { Text, View } from "react-native";
import { NativeToolBadge } from "./native-transcript";
import { literalToolResult } from "./native-tool-details";
import type { ForegroundTaskView } from "../shared/foreground-tasks";

type Entry = ForegroundTaskView["messages"][number];
export function ForegroundTranscriptEntry({ entry, colors, expanded, onToggle }: {
  entry: Entry; colors: any; expanded: boolean; onToggle(): void;
}) {
  const tool = entry.role === "tool" && !!entry.toolName;
  // Legacy call text is opaque input, never parsed back into arguments.
  // Foreground result text has always been human payload, even in old snapshots.
  return <View testID={tool ? entry.toolPhase === "call" ? "foreground-tool-call" : "foreground-tool-result" : "foreground-transcript-message"} style={{ padding: 8, borderBottomWidth: 1, borderColor: colors.border }}>
    {!tool || entry.truncated ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
      {tool ? "Tool output truncated" : entry.role}{!tool && entry.truncated ? " · message truncated" : ""}
    </Text> : null}
    {tool ? <NativeToolBadge name={entry.toolName!} status={entry.status ?? "unknown"}
      argumentsValue={entry.arguments ?? (entry.toolPhase === "call" ? entry.text : undefined)}
      result={entry.toolPhase === "call" ? undefined : literalToolResult(entry.text, "text")}
      toolPresentation={entry.toolPresentation} toolCallId={entry.toolCallId} resultSource="history" colors={colors} expanded={expanded} onToggle={onToggle} />
      : <Text selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{entry.text}</Text>}
  </View>;
}
