/*
 * Spinner state/geometry adapted from Paseo v0.12.0 components/synced-loader.tsx
 * and components/synced-loader-state.ts (950ms six-state opacity matrix).
 * Also adapted from Paseo v0.12.0 native inverted-list threshold
 * (getpaseo/paseo cafe4b01c8522ff39560241c5deb01427dc8dc5b,
 * packages/app/src/agent-stream/strategy-native.tsx:636).
 * Paseo's native FlatList is inverted and checks offsetY <= threshold. This
 * panel uses the public normal-direction ScrollView, so the equivalent check
 * measures remaining distance to the bottom. See ../licenses/PASEO-APACHE-2.0.txt.
 */
export function toTranscriptCssMetrics(metrics: { fontSize: number; lineHeight: number }): {
  fontSize: number;
  lineHeight: string;
} {
  return { fontSize: metrics.fontSize, lineHeight: `${metrics.lineHeight}px` };
}

// Same 950ms six-dot matrix as Paseo. Kept here because stock plugin compilers
// do not provide @getpaseo/plugin/shared.
const SPINNER_DURATION_MS = 950;
export const SPINNER_DOT_COUNT = 6;
const SPINNER_OPACITY_STATES = [
  [1, 0, 0.78, 0, 0.56, 0.34],
  [0.78, 1, 0.56, 0, 0.34, 0],
  [0.56, 0.78, 0.34, 1, 0, 0],
  [0.34, 0.56, 0, 0.78, 0, 1],
  [0, 0.34, 0, 0.56, 1, 0.78],
  [0, 0, 1, 0.34, 0.78, 0.56],
] as const;
const MARKDOWN_HEADING_SCALES = [1.6, 1.4, 1.2, 1.1, 1, 1] as const;

export function getNativeSpinnerStep(nowMs: number): number {
  return Math.floor(((nowMs % SPINNER_DURATION_MS) * SPINNER_DOT_COUNT) / SPINNER_DURATION_MS);
}
export function getNativeSpinnerOpacity(step: number, dot: number): number {
  return SPINNER_OPACITY_STATES[step]?.[dot] ?? 0;
}
export function getMarkdownTextMetrics(fontSize: number): { fontSize: number; lineHeight: number } {
  return { fontSize, lineHeight: Math.round(fontSize * 1.4) };
}
export function getMarkdownHeadingMetrics(baseFontSize: number, level: number): { fontSize: number; lineHeight: number } {
  const scale = MARKDOWN_HEADING_SCALES[Math.min(5, Math.max(0, level - 1))]!;
  return { fontSize: Math.round(baseFontSize * scale), lineHeight: Math.round(baseFontSize * scale * 1.3) };
}
export function getMarkdownCodeMetrics(codeFontSize: number, baseFontSize: number): { fontSize: number; lineHeight: number } {
  return { fontSize: codeFontSize, lineHeight: getMarkdownTextMetrics(baseFontSize).lineHeight };
}

export const NATIVE_SPINNER_SIZE = 14;
export const NATIVE_SPINNER_GAP = 2;
export const NATIVE_SPINNER_DOT_SIZE = (NATIVE_SPINNER_SIZE - NATIVE_SPINNER_GAP * 2) / 3;
export const NATIVE_SPINNER_GRID_WIDTH = NATIVE_SPINNER_DOT_SIZE * 2 + NATIVE_SPINNER_GAP;
export const NATIVE_SPINNER_GRID_LEFT = (NATIVE_SPINNER_SIZE - NATIVE_SPINNER_GRID_WIDTH) / 2;

export function isNativeScrollViewNearBottom(input: {
  offsetY: number; contentHeight: number; viewportHeight: number; threshold: number;
}): boolean {
  return Math.max(0, input.contentHeight - input.viewportHeight - input.offsetY) <= input.threshold;
}
