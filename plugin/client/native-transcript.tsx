/*
 * Adapted from actual Paseo v0.12.0 component logic (getpaseo/paseo,
 * cafe4b01c8522ff39560241c5deb01427dc8dc5b):
 * - packages/app/src/agent-stream/turn-footer.tsx:115-154,224-240:
 *   RunningTurnFooter/WorkingIndicator structure and metrics.
 * - packages/app/src/agent-stream/strategy-native.tsx:636: inverted-list bottom threshold.
 * - packages/app/src/components/message.tsx:868-994,1866-2175,2210-2397:
 *   ExpandableBadge dimensions/interaction and ToolCall presentation structure.
 * - packages/app/src/components/highlighted-content.tsx: code line/gutter layout.
 * - packages/app/src/components/tool-call-details.tsx:701-732: Read/Write
 *   content sections and Edit diff sections (rendered with public RN primitives).
 * Private Unistyles/detail sheets/icon components are replaced by public RN
 * primitives. Tool classification, summaries and detail data now come from the
 * bundled unchanged native Pi mapper/error helper and public protocol display
 * modules, not local copies. See ../licenses/PASEO-APACHE-2.0.txt.
 */
import { nativeCodeRows } from "./native-code-model";
import { highlightNativeRows, nativeSyntaxPalette } from "./native-code-highlight";
import { nativeToolModel } from "./native-tool-presentation";
import type { NativeToolStatus } from "./native-tool-presentation";
import { AccessibilityInfo, Pressable, Text, View } from "react-native";
import { useEffect, useState } from "react";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { getMarkdownTextMetrics, getNativeSpinnerOpacity, getNativeSpinnerStep, NATIVE_SPINNER_DOT_SIZE as DOT_SIZE, NATIVE_SPINNER_GAP as DOT_GAP, SPINNER_DOT_COUNT } from "./native-transcript-model";

// Same pure text metrics as native markdown code; the bridge owns only layout.
const TOOL_CODE_METRICS = getMarkdownTextMetrics(12);

export function NativeToolBadge({ name, status, summary, argumentsValue, details, result, toolPresentation, resultSource, toolCallId, colors, expanded, onToggle }: {
  name: string; status: NativeToolStatus; summary?: string; argumentsValue?: unknown; details?: string; result?: unknown; toolPresentation?: unknown; resultSource?: "live" | "history"; toolCallId?: string; colors: any; expanded: boolean; onToggle(): void;
}) {
  const model = nativeToolModel(name, argumentsValue, result ?? details, status, toolPresentation, resultSource, toolCallId);
  const label = model.display.displayName;
  const subtitle = model.display.summary ?? summary;
  const palette = nativeSyntaxPalette(colors);
  return <View style={{ alignSelf: "stretch", marginHorizontal: -13 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Tool ${label}${subtitle ? ` · ${subtitle}` : ""} · ${status}`} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={onToggle}
      style={{ flexDirection: "row", alignItems: "center", borderRadius: 8, borderWidth: 1, borderColor: expanded ? colors.border : "transparent", borderBottomLeftRadius: expanded ? 0 : 8, borderBottomRightRadius: expanded ? 0 : 8, backgroundColor: expanded ? colors.surface1 : "transparent", paddingHorizontal: 8, paddingVertical: 4 }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", marginRight: 4 }}>
        <Icon name={expanded ? "ChevronDown" : status === "failed" ? "TriangleAlert" : model.icon} size={12} color={status === "failed" ? colors.statusDanger : colors.foregroundMuted} />
      </View>
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 14, flexShrink: 0 }}>{label}</Text>
      {subtitle ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 14, marginLeft: 8, flexShrink: 1, minWidth: 0 }}>{subtitle}</Text> : null}
      <View style={{ flex: 1 }} />
    </Pressable>
    {expanded ? <View style={{ borderWidth: 1, borderTopWidth: 0, borderColor: colors.border, borderBottomLeftRadius: 8, borderBottomRightRadius: 8, padding: 8, backgroundColor: colors.surface1 }}>
      {model.sections.map((section, index) => section.kind !== "code" ? <View key={index} style={{ marginBottom: 8 }} testID="work-native-tool-section">
        {section.title ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, marginBottom: 4 }}>{section.title}</Text> : null}
        <ScrollView nestedScrollEnabled style={{ maxHeight: 240 }} showsVerticalScrollIndicator>
          {section.kind === "prose" ? <Text selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{section.text}</Text>
            : section.fields.map((field, fieldIndex) => <View key={fieldIndex} style={{ flexDirection: "row", gap: 12, marginBottom: 4 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 12, minWidth: 80, flexShrink: 1 }}>{field.label}</Text>
              <Text selectable style={{ color: colors.foreground, fontSize: 14, flex: 1 }}>{field.value}</Text>
            </View>)}
        </ScrollView>
      </View> : <View key={index} style={{ marginBottom: 8 }}>
        <Text style={{ color: section.error ? colors.statusDanger : colors.foregroundMuted, fontSize: 11, marginBottom: 4 }}>{section.label}</Text>
        <ScrollView nestedScrollEnabled style={{ maxHeight: 240 }} showsVerticalScrollIndicator>
          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
            <View testID="work-native-code-surface" dataSet={{ pmono: "" }}>
              {highlightNativeRows(nativeCodeRows(section.text, {
                tone: section.tone,
                startLine: section.startLine,
                unifiedDiff: section.unifiedDiff,
              }), section.text, section.filePath, section.unifiedDiff).map((row, line) => <View key={line} style={{ flexDirection: "row", backgroundColor: row.tone === "removed" ? "rgba(220,60,60,0.12)" : row.tone === "added" ? "rgba(40,180,90,0.12)" : "transparent" }}>
                {row.number !== undefined ? <Text testID="work-code-line-number" style={{ color: colors.foregroundMuted, fontFamily: "monospace", ...TOOL_CODE_METRICS, minWidth: 36, paddingRight: 12, textAlign: "right", userSelect: "none" }}>{String(row.number)}</Text> : null}
                <Text testID="work-code-line" selectable style={{ color: section.error ? colors.statusDanger : colors.foreground, fontFamily: "monospace", ...TOOL_CODE_METRICS }}>{section.tone === "removed" ? "− " : section.tone === "added" ? "+ " : ""}{row.tokens ? row.tokens.map((token, tokenIndex) => <Text key={tokenIndex} dataSet={{ syntaxRole: token.style ?? "base" }} style={{ color: token.style ? palette[token.style] ?? colors.foreground : colors.foreground }}>{token.text || " "}</Text>) : row.text || " "}</Text>
              </View>)}
            </View>
          </ScrollView>
        </ScrollView>
      </View>)}
    </View> : null}
  </View>;
}

// Adapted from Paseo's SyncedLoader state (Apache-2.0); see ../licenses/PASEO-APACHE-2.0.txt.

function NativeSpinner({ color }: { color: string }) {
  const [step, setStep] = useState(() => getNativeSpinnerStep(Date.now()));
  useEffect(() => {
    let frame = 0;
    let disposed = false, reduceMotion = false;
    const tick = () => {
      if (disposed || reduceMotion) return;
      setStep(getNativeSpinnerStep(Date.now()));
      frame = requestAnimationFrame(tick);
    };
    const onMotion = (reduced: boolean) => {
      if (disposed) return;
      reduceMotion = reduced;
      cancelAnimationFrame(frame);
      setStep(reduced ? 0 : getNativeSpinnerStep(Date.now()));
      if (!reduced) frame = requestAnimationFrame(tick);
    };
    void AccessibilityInfo.isReduceMotionEnabled().then(onMotion);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", onMotion);
    frame = requestAnimationFrame(tick);
    return () => { disposed = true; cancelAnimationFrame(frame); subscription.remove(); };
  }, []);
  const dot = DOT_SIZE, gap = DOT_GAP;
  return <View accessibilityLabel="Assistant is working" style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
    <View style={{ width: dot * 2 + gap, height: dot * 3 + gap * 2, position: "relative" }}>
      {Array.from({ length: SPINNER_DOT_COUNT }, (_, i) => <View key={i} style={{ position: "absolute", left: (i % 2) * (dot + gap), top: Math.floor(i / 2) * (dot + gap), width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color, opacity: getNativeSpinnerOpacity(step, i) }} />)}
    </View>
  </View>;
}

/** Same compact 24px inline row as Paseo's RunningTurnFooter/WorkingIndicator. */
export function NativeRunningTurnFooter({ color }: { color: string }) {
  return <View testID="turn-working-indicator" style={{ height: 24, flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 12, marginTop: 13, paddingBottom: 16 }}>
    <View style={{ marginLeft: -2 }}><NativeSpinner color={color} /></View>
  </View>;
}
