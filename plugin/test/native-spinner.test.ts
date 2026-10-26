import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NATIVE_SPINNER_DOT_SIZE, NATIVE_SPINNER_GAP, NATIVE_SPINNER_GRID_LEFT,
  NATIVE_SPINNER_GRID_WIDTH, getNativeSpinnerOpacity, getNativeSpinnerStep,
} from "../client/native-transcript-model.ts";

test("native spinner geometry centers the 2x3 dot grid in 14px", () => {
  assert.equal(NATIVE_SPINNER_DOT_SIZE, 10 / 3);
  assert.equal(NATIVE_SPINNER_GAP, 2);
  assert.ok(Math.abs(NATIVE_SPINNER_GRID_WIDTH - 26 / 3) < 1e-12);
  assert.ok(Math.abs(NATIVE_SPINNER_GRID_LEFT - 8 / 3) < 1e-12);
});

test("native spinner wall-clock phase and opacity matrix match Paseo", () => {
  assert.deepEqual([0, 158, 317, 475, 634, 792, 950].map(getNativeSpinnerStep), [0, 0, 2, 3, 4, 5, 0]);
  assert.deepEqual(Array.from({ length: 6 }, (_, step) => Array.from({ length: 6 }, (_, dot) => getNativeSpinnerOpacity(step, dot))), [
    [1,0,.78,0,.56,.34], [.78,1,.56,0,.34,0], [.56,.78,.34,1,0,0],
    [.34,.56,0,.78,0,1], [0,.34,0,.56,1,.78], [0,0,1,.34,.78,.56],
  ]);
  assert.equal(getNativeSpinnerOpacity(-1, 0), 0);
});
