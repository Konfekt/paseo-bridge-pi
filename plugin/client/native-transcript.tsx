/*
 * Adapted from Paseo v0.12.0 (getpaseo/paseo, cafe4b01c8522ff39560241c5deb01427dc8dc5b):
 * packages/app/src/agent-stream/turn-footer.tsx (RunningTurnFooter/WorkingIndicator)
 * and packages/app/src/components/message.tsx (ExpandableBadge).
 * Copyright (c) 2025-present Mohamed Boudra. Modified for the public Paseo
 * plugin React Native surface; internal app hooks, Unistyles, icons and
 * shimmer implementation are intentionally not imported. See ../licenses/PASEO-APACHE-2.0.txt.
 */
import { ActivityIndicator, Pressable, Text, View } from "react-native";

export function NativeToolBadge({ name, status, details, colors, expanded, onToggle }: {
  name: string; status: string; details: string; colors: any; expanded: boolean; onToggle(): void;
}) {
  return <View style={{ alignSelf: "flex-start", maxWidth: "100%" }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Tool ${name} · ${status}`} accessibilityState={{ expanded }} onPress={onToggle}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12 }}>{expanded ? "⌄" : "›"} {name}</Text>
      <Text style={{ color: status === "failed" ? colors.statusDanger : colors.foregroundMuted, fontSize: 12 }}>{status}</Text>
    </Pressable>
    {expanded ? <View style={{ padding: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 6, backgroundColor: colors.surface1 }}>
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{details}</Text>
    </View> : null}
  </View>;
}

/** Same compact 24px inline row as Paseo's running turn footer. */
export function NativeRunningTurnFooter({ color }: { color: string }) {
  return <View testID="turn-working-indicator" style={{ height: 24, flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 12, marginTop: 13, paddingBottom: 16 }}>
    <View style={{ marginLeft: -2 }}><ActivityIndicator accessibilityLabel="Assistant is working" size="small" color={color} /></View>
  </View>;
}
