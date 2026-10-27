import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadNativeTranscriptModel } from "./helpers/load-native-transcript-model.mjs";

const model = await loadNativeTranscriptModel();
after(model.cleanup);

const { getMarkdownCodeMetrics, getMarkdownTextMetrics, isNativeScrollViewNearBottom, toTranscriptCssMetrics } = model;

test("web markdown line heights retain CSS units while native metrics stay numeric", () => {
  const textMetrics = getMarkdownTextMetrics(15);
  const codeMetrics = getMarkdownCodeMetrics(12, 15);

  assert.deepEqual(textMetrics, { fontSize: 15, lineHeight: 21 });
  assert.deepEqual(toTranscriptCssMetrics(textMetrics), { fontSize: 15, lineHeight: "21px" });
  assert.deepEqual(codeMetrics, { fontSize: 12, lineHeight: 21 });
  assert.deepEqual(toTranscriptCssMetrics(codeMetrics), { fontSize: 12, lineHeight: "21px" });
});

test("native transcript bottom threshold follows content but disengages during upward scroll", () => {
  const metrics = { contentHeight: 1000, viewportHeight: 300, threshold: 32 };
  assert.equal(isNativeScrollViewNearBottom({ ...metrics, offsetY: 668 }), true);
  assert.equal(isNativeScrollViewNearBottom({ ...metrics, offsetY: 667 }), false);
  assert.equal(isNativeScrollViewNearBottom({ ...metrics, offsetY: 200 }), false);
  assert.equal(isNativeScrollViewNearBottom({ ...metrics, offsetY: 900 }), true, "short content remains at the bottom");
});
