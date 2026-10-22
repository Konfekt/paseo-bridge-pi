import { useState, type ReactNode } from "react";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";

/** Paseo 0.12 settings/control geometry. Domain state stays in each panel. */
export type PresentationColors = PluginWorkspacePanelProps["theme"]["colors"];
export const nativeText = { fontSize: 14, lineHeight: 20 } as const;
export const secondaryText = { fontSize: 12, lineHeight: 18 } as const;

export function Surface({ colors, children, style, padded = false }: {
  colors: PresentationColors; children: ReactNode; style?: ViewStyle; padded?: boolean;
}) {
  return <View style={[{ backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: "hidden", ...(padded ? { padding: 12, gap: 8 } : {}) }, style]}>{children}</View>;
}

export function SectionHeading({ colors, title, children }: {
  colors: PresentationColors; title: string; children?: ReactNode;
}) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, marginBottom: 8 }}>
    <Text accessibilityRole="header" style={{ ...secondaryText, color: colors.foregroundMuted, flex: 1 }}>{title}</Text>{children}
  </View>;
}

export function Metadata({ colors, children, style, selectable = false }: {
  colors: PresentationColors; children: ReactNode; style?: TextStyle; selectable?: boolean;
}) {
  return <Text selectable={selectable} style={[{ ...secondaryText, color: colors.foregroundMuted }, style]}>{children}</Text>;
}

export function NativeRow({ colors, title, detail, leading, trailing, children, onPress, disabled = false, selected = false, expanded, style }: {
  colors: PresentationColors; title: string; detail?: string; leading?: ReactNode; trailing?: ReactNode; children?: ReactNode;
  onPress(): void; disabled?: boolean; selected?: boolean; expanded?: boolean; style?: ViewStyle;
}) {
  const [hovered, setHovered] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={title}
    accessibilityState={{ disabled, selected, ...(expanded === undefined ? {} : { expanded }) }} disabled={disabled} onPress={onPress}
    onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={({ pressed }) => [{ paddingHorizontal: 12, paddingVertical: 10, gap: 6, opacity: disabled ? 0.5 : 1,
      backgroundColor: !disabled && (pressed || selected) ? colors.surface2 : !disabled && hovered ? colors.surface1 : "transparent" }, style]}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
      {leading}<View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ ...nativeText, color: colors.foreground }}>{title}</Text>
        {detail ? <Metadata colors={colors}>{detail}</Metadata> : null}
      </View>{trailing}
    </View>{children}
  </Pressable>;
}

export function NativeButton({ colors, label, onPress, disabled = false, danger = false, style }: {
  colors: PresentationColors; label: string; onPress(): void; disabled?: boolean; danger?: boolean; style?: ViewStyle;
}) {
  const [hovered, setHovered] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={({ pressed }) => [{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
      alignItems: "center", justifyContent: "center", opacity: disabled ? 0.5 : 1,
      backgroundColor: !disabled && (hovered || pressed) ? colors.surface2 : colors.surface1 }, style]}>
    <Text style={{ ...nativeText, color: danger ? colors.statusDanger : colors.foreground }}>{label}</Text>
  </Pressable>;
}

/** A bounded selectable document, not a terminal or a new control surface. */
export function OutputWell({ colors, text, monospace = false, platform, maxHeight = 320 }: {
  colors: PresentationColors; text: string; monospace?: boolean; platform?: string; maxHeight?: number;
}) {
  return <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface0, overflow: "hidden" }}>
    <ScrollView nestedScrollEnabled style={{ maxHeight }} contentContainerStyle={{ padding: 12 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: monospace ? 12 : 14, lineHeight: monospace ? 18 : 20,
        ...(monospace ? { fontFamily: platform === "ios" ? "Menlo" : "monospace" } : {}) }}>{text}</Text>
    </ScrollView>
  </View>;
}
