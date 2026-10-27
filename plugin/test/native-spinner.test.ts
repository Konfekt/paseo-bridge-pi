import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadNativeTranscriptModel } from "./helpers/load-native-transcript-model.mjs";

const model = await loadNativeTranscriptModel();
after(model.cleanup);

const {
  NATIVE_SPINNER_DOT_SIZE,
  NATIVE_SPINNER_GAP,
  NATIVE_SPINNER_GRID_LEFT,
  NATIVE_SPINNER_GRID_WIDTH,
  getNativeSpinnerOpacity,
  getNativeSpinnerStep,
} = model;

test("native spinner geometry centers the 2x3 dot grid in 14px", () => {
  assert.equal(NATIVE_SPINNER_DOT_SIZE, 10 / 3);
  assert.equal(NATIVE_SPINNER_GAP, 2);
  assert.ok(Math.abs(NATIVE_SPINNER_GRID_WIDTH - 26 / 3) < 1e-12);
  assert.ok(Math.abs(NATIVE_SPINNER_GRID_LEFT - 8 / 3) < 1e-12);
});

test("native spinner wall-clock phase and opacity matrix match Paseo", () => {
  assert.deepEqual(
    [0, 158, 159, 316, 317, 474, 475, 633, 634, 791, 792, 949, 950].map(getNativeSpinnerStep),
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 0],
  );
  assert.deepEqual(Array.from({ length: 6 }, (_, step) => Array.from({ length: 6 }, (_, dot) => getNativeSpinnerOpacity(step, dot))), [
    [1, 0, 0.78, 0, 0.56, 0.34],
    [0.78, 1, 0.56, 0, 0.34, 0],
    [0.56, 0.78, 0.34, 1, 0, 0],
    [0.34, 0.56, 0, 0.78, 0, 1],
    [0, 0.34, 0, 0.56, 1, 0.78],
    [0, 0, 1, 0.34, 0.78, 0.56],
  ]);
  assert.equal(getNativeSpinnerOpacity(-1, 0), 0);
});
