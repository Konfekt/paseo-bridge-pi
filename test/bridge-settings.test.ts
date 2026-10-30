import './fixtures/settings-sdk-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Set HOME before importing: legacySettingsFile is intentionally captured once.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-settings-'));
const originalEnv = { ...process.env };
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
const settings = await import('../extension/bridge-settings.ts');
const canonical = settings.bridgeSettingsFile();
const legacy = path.join(process.env.HOME, '.pi/paseo-bridge/settings.json');
function put(file: string, value: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
test.after(() => {
  process.env = originalEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

test('canonical settings supersede legacy; only absence falls back to the boolean preference', () => {
  put(legacy, JSON.stringify({ auto: false, token: 'never migrate', unrelated: 42 }));
  assert.deepEqual(settings.readBridgeSettings(), { auto: false });
  for (const content of ['{', 'null', '[]', '42', '{}']) {
    put(canonical, content);
    assert.deepEqual(settings.readBridgeSettings(), {}, content);
  }
  fs.unlinkSync(canonical);
  fs.mkdirSync(canonical); // unreadable as JSON is not absence either
  assert.deepEqual(settings.readBridgeSettings(), {});
  fs.rmdirSync(canonical);
  put(legacy, '{"auto":"false","token":"secret"}');
  assert.deepEqual(settings.readBridgeSettings(), {});
  put(legacy, '{"auto":false,"token":"secret"}');
  settings.writeBridgeSettings({ auto: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(canonical, 'utf8')), { auto: true });
  assert.equal(JSON.parse(fs.readFileSync(legacy, 'utf8')).token, 'secret');
});

test('writes preserve unrelated canonical keys, replace atomically, and create private files', () => {
  put(canonical, '{"other":{"keep":1},"auto":false}');
  const before = fs.statSync(canonical);
  settings.writeBridgeSettings({ auto: true });
  assert.deepEqual(settings.readBridgeSettings(), { other: { keep: 1 }, auto: true });
  assert.notEqual(fs.statSync(canonical).ino, before.ino);
  assert.equal(fs.statSync(canonical).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(canonical)), ['settings.json']);
});

test('refuses malformed existing settings without clobbering bytes', () => {
  put(canonical, '{broken');
  assert.throws(() => settings.writeBridgeSettings({ auto: false }), /refusing to overwrite/);
  assert.equal(fs.readFileSync(canonical, 'utf8'), '{broken');
});

test('immutable targets, symlinks (including dangling), and directories have no write effects', () => {
  const dir = path.join(root, 'targets');
  fs.mkdirSync(dir);
  const target = path.join(dir, 'target');
  put(target, 'original');
  const link = path.join(dir, 'link');
  fs.symlinkSync(target, link);
  const dangling = path.join(dir, 'dangling');
  fs.symlinkSync(path.join(dir, 'missing'), dangling);
  fs.chmodSync(target, 0o444);
  try {
    for (const file of [target, link, dangling, dir]) {
      assert.throws(() => settings.writeMutableJson(file, { auto: true }), /Cannot save.*immutable or symlinked/);
    }
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.equal(fs.readlinkSync(link), target);
    assert.equal(fs.existsSync(path.join(dir, 'missing')), false);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['dangling', 'link', 'target']);
  } finally { fs.chmodSync(target, 0o600); }
  fs.chmodSync(dir, 0o555);
  try {
    assert.throws(() => settings.writeMutableJson(path.join(dir, 'new'), {}), /immutable directory/);
    assert.equal(fs.existsSync(path.join(dir, 'new')), false);
  } finally { fs.chmodSync(dir, 0o755); }
});

test('serialization failure cleans the temporary file and preserves the old file', () => {
  const file = path.join(root, 'failed/settings.json');
  put(file, '{"keep":true}');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => settings.writeMutableJson(file, circular), /Cannot save/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"keep":true}');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
});

test('environment parsing and persisted precedence preserve legacy opt-out presence semantics', () => {
  for (const value of ['0', ' FALSE ', 'off']) {
    process.env.PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT = value;
    assert.equal(settings.environmentBoolean('PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT'), false);
  }
  for (const value of ['1', ' TRUE ', 'on']) {
    process.env.PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT = value;
    assert.equal(settings.environmentBoolean('PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT', false), true);
  }
  process.env.PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT = 'invalid';
  assert.equal(settings.environmentBoolean('PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT', false), false);
  put(canonical, '{"auto":false}');
  assert.equal(settings.isAutoEnabled(), false);
  put(canonical, '{"auto":true}');
  process.env.PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT = '0';
  assert.equal(settings.isAutoEnabled(), true);
  for (const [no, positive, enabled] of [
    ['PI_PASEO_BRIDGE_NO_IMPORT', 'PI_PASEO_BRIDGE_IMPORT_SESSIONS', settings.isImportEnabled],
  ] as const) {
    delete process.env[no];
    process.env[positive] = 'off';
    assert.equal(enabled(), false);
    process.env[positive] = 'on';
    assert.equal(enabled(), true);
    process.env[no] = '0';
    assert.equal(enabled(), false);
  }
});
