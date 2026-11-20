import assert from "node:assert/strict";
import test from "node:test";

import { addShimToPaseoConfig, removeShimFromPaseoConfig } from "../scripts/config.js";

const shim = ["/usr/bin/node", "/pkg/shim/pi-paseo-shim.js"];

test("installing the shim preserves unrelated Paseo configuration", () => {
  const config: any = { daemon: { listen: "x" }, agents: { providers: { pi: { env: { A: "1" } } } } };
  assert.equal(addShimToPaseoConfig(config, shim), "installed");
  assert.deepEqual(config, { daemon: { listen: "x" }, agents: { providers: { pi: { env: { A: "1" }, command: shim } } } });
  assert.equal(addShimToPaseoConfig(config, shim), "already-installed");
});

test("installing never replaces another pi provider command", () => {
  const config: any = { agents: { providers: { pi: { command: ["/opt/pi-wrapper"] } } } };
  assert.equal(addShimToPaseoConfig(config, shim), "conflict");
  assert.deepEqual(config.agents.providers.pi.command, ["/opt/pi-wrapper"]);
});

test("reinstalling refreshes a moved bridge without losing provider settings", () => {
  const config: any = { agents: { providers: { pi: {
    command: ["/old/node", "/old/checkout/shim/pi-paseo-shim.js"],
    env: { PI_REAL_BIN: "/opt/pi" },
  } } }, pluginsEnabled: true };
  assert.equal(addShimToPaseoConfig(config, shim), "installed");
  assert.deepEqual(config, { agents: { providers: { pi: {
    command: shim,
    env: { PI_REAL_BIN: "/opt/pi" },
  } } }, pluginsEnabled: true });
  assert.equal(addShimToPaseoConfig(config, shim), "already-installed");
});

test("reinstalling refreshes only a changed Node executable", () => {
  const config: any = { agents: { providers: { pi: { command: ["/old/node", shim[1]] } } } };
  assert.equal(addShimToPaseoConfig(config, shim), "installed");
  assert.deepEqual(config.agents.providers.pi.command, shim);
});

test("uninstalling removes only the shim and prunes empty containers", () => {
  const empty: any = { agents: { providers: { pi: { command: shim } } }, other: true };
  assert.equal(removeShimFromPaseoConfig(empty), "removed");
  assert.deepEqual(empty, { other: true });

  const kept: any = { agents: { providers: { pi: { command: shim, env: { A: "1" } } } } };
  assert.equal(removeShimFromPaseoConfig(kept), "removed");
  assert.deepEqual(kept, { agents: { providers: { pi: { env: { A: "1" } } } } });

  const foreign: any = { agents: { providers: { pi: { command: ["/opt/pi-wrapper"] } } } };
  assert.equal(removeShimFromPaseoConfig(foreign), "conflict");
  assert.deepEqual(foreign.agents.providers.pi.command, ["/opt/pi-wrapper"]);

  assert.equal(removeShimFromPaseoConfig(null), "not-installed");
  assert.equal(removeShimFromPaseoConfig({}), "not-installed");
});
