/*
 * Adapted from Paseo v0.12.0 native inverted-list threshold
 * (getpaseo/paseo cafe4b01c8522ff39560241c5deb01427dc8dc5b,
 * packages/app/src/agent-stream/strategy-native.tsx:636).
 * Paseo's native FlatList is inverted and checks offsetY <= threshold. This
 * panel uses the public normal-direction ScrollView, so the equivalent check
 * measures remaining distance to the bottom. See ../licenses/PASEO-APACHE-2.0.txt.
 */
export function isNativeScrollViewNearBottom(input: {
  offsetY: number; contentHeight: number; viewportHeight: number; threshold: number;
}): boolean {
  return Math.max(0, input.contentHeight - input.viewportHeight - input.offsetY) <= input.threshold;
}
