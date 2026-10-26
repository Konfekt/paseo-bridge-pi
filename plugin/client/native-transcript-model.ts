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
export const NATIVE_SPINNER_SIZE = 14;
export const NATIVE_SPINNER_GAP = 2;
export const NATIVE_SPINNER_DOT_SIZE = (NATIVE_SPINNER_SIZE - NATIVE_SPINNER_GAP * 2) / 3;
export const NATIVE_SPINNER_GRID_WIDTH = NATIVE_SPINNER_DOT_SIZE * 2 + NATIVE_SPINNER_GAP;
export const NATIVE_SPINNER_GRID_LEFT = (NATIVE_SPINNER_SIZE - NATIVE_SPINNER_GRID_WIDTH) / 2;
const NATIVE_SPINNER_OPACITY = [[1,0,.78,0,.56,.34],[.78,1,.56,0,.34,0],[.56,.78,.34,1,0,0],[.34,.56,0,.78,0,1],[0,.34,0,.56,1,.78],[0,0,1,.34,.78,.56]] as const;
export function getNativeSpinnerStep(nowMs: number): number { return Math.floor(((nowMs % 950) * 6) / 950); }
export function getNativeSpinnerOpacity(step: number, dot: number): number { return NATIVE_SPINNER_OPACITY[step]?.[dot] ?? 0; }

export function isNativeScrollViewNearBottom(input: {
  offsetY: number; contentHeight: number; viewportHeight: number; threshold: number;
}): boolean {
  return Math.max(0, input.contentHeight - input.viewportHeight - input.offsetY) <= input.threshold;
}
