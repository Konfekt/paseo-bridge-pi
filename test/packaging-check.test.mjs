import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// This suite is explicitly wired by nix/checks.nix, not the general runtime glob.
const artifact = process.env.BRIDGE_CHECK_PACKAGE;
const wrapper = process.env.BRIDGE_CHECK_RPC;
test('installed package contains its advertised extension, shim, plugin and scripts', () => {
  assert.ok(artifact);
  const manifest = JSON.parse(readFileSync(join(artifact, 'package.json'), 'utf8'));
  for (const entry of manifest.files) assert.ok(existsSync(join(artifact, entry)), entry);
  for (const entry of ['extension/index.ts', 'extension/bridge-settings.ts', 'shim/pi-paseo-shim.js',
    'plugin/paseo-plugin.json', 'scripts/config.js', 'nix/mk-bridge.nix']) {
    assert.ok(existsSync(join(artifact, entry)), entry);
  }
});

test('generated RPC wrapper preserves explicit extensions, quoting, and environment without discovery', () => {
  assert.ok(wrapper);
  const args = ['--session', '/tmp/session with spaces.jsonl', "literal';$(false)"];
  const result = spawnSync(wrapper, args, { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  const peer = JSON.parse(result.stdout);
  assert.deepEqual(peer.argv, ['--no-extensions', '--extension', '/fixture/permission gate.ts',
    '--extension', join(artifact, 'extension/index.ts'), '--extension', "/fixture/provider's extension.ts", ...args]);
  assert.deepEqual(peer.env, {
    PASEO_CLI: '/fixture/paseo/bin/paseo', PASEO_TMUX_TOPOLOGY: '0',
    PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT: '0', PI_PASEO_BRIDGE_IMPORT_SESSIONS: '0',
    PI_PASEO_BRIDGE_GENERATE_TITLES: '1', PI_PASEO_BRIDGE_DEBUG: '0',
    PASEO_HOST: "host with 'quotes' and $dollars", PASEO_PASSWORD_FILE: '/run/secrets/paseo password',
  });
});
