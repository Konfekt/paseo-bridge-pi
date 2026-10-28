import { Pressable, Text, View } from "react-native";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** Current hosts expose workspace navigation, not native tab selection. The
 * accepted two-step action opens the exact workspace; native Changes is next.
 * Uses the native composer pill's pure visual contract with public primitives;
 * no private app imports, synthetic counts, or custom diff renderer.
 */
export function WorktreeWorkspaceAction({ path, diffStat, disabled, onPress, colors }: {
	path: string;
	diffStat?: { additions: number; deletions: number } | null;
	disabled: boolean;
	onPress: () => void;
	colors: PluginAgentPanelProps["theme"]["colors"];
}) {
	const reported = diffStat != null;
	return <Pressable accessibilityRole="button" accessibilityLabel={`Open worktree workspace ${path}; then select native Changes`}
		accessibilityHint={`${reported ? `Native comparison: ${diffStat.additions} additions, ${diffStat.deletions} deletions.` : "Native line counts unavailable."} Opens this worktree in the current project. Select native Changes in that workspace to view its diff.`}
		accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
		style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4, opacity: disabled ? 0.5 : 1 }}>
		<View style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32, paddingHorizontal: 12, paddingVertical: 4,
			borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
			{reported ? <>
				<Text style={{ fontSize: 14, color: colors.statusSuccess }}>+{compact.format(diffStat.additions).toLowerCase()}</Text>
				<Text style={{ fontSize: 14, color: colors.statusDanger }}>−{compact.format(diffStat.deletions).toLowerCase()}</Text>
			</> : <Text style={{ fontSize: 12, color: colors.foregroundMuted }}>Open ↗</Text>}
		</View>
	</Pressable>;
}
