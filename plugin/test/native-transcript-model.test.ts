import assert from "node:assert/strict";
import { test } from "node:test";
import { isNativeScrollViewNearBottom } from "../client/native-transcript-model.ts";

test("native transcript bottom threshold follows content but disengages during upward scroll", () => {
  const metrics = { contentHeight: 1000, viewportHeight: 300, threshold: 32 };
  assert.equal(isNativeScrollViewNearBottom({ ...metrics, offsetY: 668 }), true);
  assert.equal(isNativeScrollViewNearBottom({ ...metrics, offsetY: 667 }), false);
  assert.equal(isNativeScrollViewNearBottom({ ...metrics, offsetY: 200 }), false);
  assert.equal(isNativeScrollViewNearBottom({ ...metrics, offsetY: 900 }), true, "short content remains at the bottom");
});
