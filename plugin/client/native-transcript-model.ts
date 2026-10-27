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
import { getSpinnerDotOpacity, getSpinnerStep } from "@getpaseo/plugin/shared";

export function toTranscriptCssMetrics(metrics: { fontSize: number; lineHeight: number }): {
  fontSize: number;
  lineHeight: string;
} {
  return { fontSize: metrics.fontSize, lineHeight: `${metrics.lineHeight}px` };
}

export const NATIVE_SPINNER_SIZE = 14;
export const NATIVE_SPINNER_GAP = 2;
export const NATIVE_SPINNER_DOT_SIZE = (NATIVE_SPINNER_SIZE - NATIVE_SPINNER_GAP * 2) / 3;
export const NATIVE_SPINNER_GRID_WIDTH = NATIVE_SPINNER_DOT_SIZE * 2 + NATIVE_SPINNER_GAP;
export const NATIVE_SPINNER_GRID_LEFT = (NATIVE_SPINNER_SIZE - NATIVE_SPINNER_GRID_WIDTH) / 2;
export const getNativeSpinnerStep = getSpinnerStep;
export const getNativeSpinnerOpacity = getSpinnerDotOpacity;

export function isNativeScrollViewNearBottom(input: {
  offsetY: number; contentHeight: number; viewportHeight: number; threshold: number;
}): boolean {
  return Math.max(0, input.contentHeight - input.viewportHeight - input.offsetY) <= input.threshold;
}
