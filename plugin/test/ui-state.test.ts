import test from "node:test";
import assert from "node:assert/strict";
import { gateControlsDisabled, gateLabel, hasNativeAccessModes } from "../shared/ui-state.ts";

const ready = { available: true, enabled: false, pending: false, fetching: false, stale: false, error: false };

test("access labels map to the existing prompt policy without defaulting unknown state", () => {
  assert.equal(gateLabel({ available: true, enabled: true }), "Dangerous ask");
  assert.equal(gateLabel({ available: true, enabled: false }), "Full access");
  assert.equal(gateLabel({ available: false, enabled: null }), "Access unavailable");
  assert.equal(gateLabel(), "Access · …");
});

test("fallback is hidden only when both native access modes are advertised", () => {
  assert.equal(hasNativeAccessModes(), false);
  assert.equal(hasNativeAccessModes([{ id: "default" }]), false);
  assert.equal(hasNativeAccessModes([{ id: "pi-prompts-on" }]), false);
  assert.equal(hasNativeAccessModes([{ id: "pi-prompts-on" }, { id: "pi-prompts-off" }]), true);
});

test("stale, failed, unavailable, pending and reconnect-refresh states fail closed", () => {
  assert.equal(gateControlsDisabled(ready), false);
  for (const key of ["pending", "fetching", "stale", "error"] as const) {
    assert.equal(gateControlsDisabled({ ...ready, [key]: true }), true, key);
  }
  assert.equal(gateControlsDisabled({ ...ready, available: false, enabled: null }), true);
  assert.equal(gateControlsDisabled({ ...ready, fetching: true }), true, "reconnect refresh");
});
