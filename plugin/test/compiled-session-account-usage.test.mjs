import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { once } from 'node:events';

const compiler = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler, 'PASEO_PLUGIN_COMPILER is required');
const require = createRequire(resolve(compiler));
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'session-usage-compile-'));
after(() => rm(root, { recursive: true, force: true }));
for (const directory of ['server', 'shared']) await cp(join(pluginRoot, directory), join(root, directory), { recursive: true });
await writeFile(join(root, 'index.server.ts'), `export { registerSessionAccountUsage } from "./server/session-account-usage";`);
const { compilePlugin } = await import(pathToFileURL(resolve(compiler)));
const { serverBundle } = await compilePlugin({ server: join(root, 'index.server.ts') });
let activeHome;
const { registerSessionAccountUsage } = (0, eval)(serverBundle)(name => name === 'node:os' ? { ...require(name), homedir: () => activeHome } : require(name));
const hash = value => createHash('sha256').update(value).digest('hex');
const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const identity = (provider, accountId, subject) => hash(JSON.stringify([provider, accountId, subject]));

async function fixture({ provider = 'openai-codex', defaultSelected = false, accountId = 'same-name', subject = 'work-subject', reportedSubject = subject, reportedAccount = accountId, providerMetadata = true, supported = true, snapshots, includeOpenai = false } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'session-usage-fixture-'));
  activeHome = rootDir;
  const base = join(rootDir, '.pi', 'paseo-bridge');
  const operators = join(base, 'operators');
  const dir = join(rootDir, 'agent');
  await mkdir(operators, { recursive: true, mode: 0o700 }); await chmod(join(rootDir, '.pi'), 0o700); await chmod(base, 0o700); await chmod(operators, 0o700);
  await mkdir(dir, { mode: 0o700 });
  const accountClaims = { sub: reportedSubject, 'https://api.openai.com/auth': { chatgpt_account_id: reportedAccount, chatgpt_user_id: reportedSubject } };
  const codexCred = { type: 'oauth', access: jwt(accountClaims), expires: Date.now() + 3600000, accountId };
  const personal = { type: 'oauth', access: jwt({ sub: 'personal-subject', chatgpt_account_id: 'personal', 'https://api.openai.com/auth': { chatgpt_account_id: 'personal', chatgpt_user_id: 'personal-subject' } }), expires: Date.now() + 3600000, accountId: 'personal' };
  const accounts = { version: 1, providers: { 'openai-codex': { accounts: { [accountId]: codexCred } }, openai: { accounts: { [accountId]: personal } } } };
  if (includeOpenai) accounts.providers.openai.accounts[accountId] = { ...personal, access: jwt({ sub: 'native-subject', chatgpt_account_id: 'native-account', 'https://api.openai.com/auth': { chatgpt_account_id: 'native-account', chatgpt_user_id: 'native-subject' } }), accountId: 'native-account', clientId: 'native-client', scopes: ['chatgpt.tokens.use.direct'] };
  const auth = { 'openai-codex': includeOpenai ? { type: 'oauth', access: jwt({ sub: 'companion-subject', 'https://api.openai.com/auth': { chatgpt_account_id: 'native-account' } }), expires: Date.now() + 3600000, accountId: 'native-account' } : codexCred };
  if (includeOpenai) auth.openai = { ...accounts.providers.openai.accounts[accountId], clientId: 'native-client', scopes: ['chatgpt.tokens.use.direct'] };
  await writeFile(join(dir, 'pi-accounts.json'), JSON.stringify(accounts), { mode: 0o600 });
  await writeFile(join(dir, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
  if (includeOpenai) await writeFile(join(dir, 'pi-usage.json'), JSON.stringify({ openaiUseCodexUsage: true }), { mode: 0o600 });

  const socketPath = join(rootDir, 'controls.sock');
  let snapshotIndex = 0;
  let activeProvider = provider;
  const baseSnapshot = () => {
    const current = snapshots?.[Math.min(snapshotIndex, snapshots.length - 1)] ?? {};
    snapshotIndex++;
    const providerKey = activeProvider === 'openai-codex' ? identity('openai-codex', accountId, subject) : identity('openai', 'native-account', 'native-subject');
    return {
      protocol: 1, serviceEpoch: 'service-1', selectionRevision: 3, sessionId: 'session-1',
      ...(providerMetadata ? { providerId: current.providerId ?? activeProvider, supportedProviders: supported ? ['openai', 'openai-codex'] : ['openai'] } : {}),
      accounts: [{ id: accountId, label: 'Work', authKind: 'oauth' }], currentAccountId: defaultSelected ? null : accountId,
      defaultSelected, activationStatus: defaultSelected ? 'inactive' : 'active', busy: false, canSwitch: true,
      usage: { effectiveCredential: defaultSelected ? 'chatgpt-grant-configured' : 'chatgpt-grant-matched-refreshed', status: 'local-binding-confirmed', remoteEntitlement: 'not-queried', accountKey: current.accountKey ?? providerKey,
        ...(includeOpenai && activeProvider === 'openai' ? { nativeRegistrationKey: hash(JSON.stringify(['openai-native', 'native-client', 'native-subject'])), nativeRegistrationVersion: 1 } : {}), settingsUrl: 'https://chatgpt.com/settings/usage' },
      ...current,
    };
  };
  const server = net.createServer(socket => {
    let data = '';
    socket.on('data', chunk => {
      data += chunk.toString();
      const end = data.indexOf('\n'); if (end < 0) return;
      const request = JSON.parse(data.slice(0, end));
      activeProvider = request.request?.providerId ?? 'openai';
      const result = baseSnapshot();
      socket.end(`${JSON.stringify({ v: 1, type: 'account_controls', id: request.id, success: true, agentId: 'agent', sessionId: 'session-1', runtimeEpoch: '123e4567-e89b-42d3-a456-426614174000', serviceEpoch: 'service-1', data: result })}\n`);
    });
  });
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
  const capability = 'a'.repeat(64);
  const descriptor = { version: 1, socketPath, capability, agentId: 'agent', sessionId: 'session-1', runtimeEpoch: '123e4567-e89b-42d3-a456-426614174000', serviceEpoch: 'service-1' };
  const descriptorFile = join(operators, `${hash('agent')}.accounts.json`);
  await writeFile(descriptorFile, JSON.stringify(descriptor), { mode: 0o600 });
  const registered = {};
  registerSessionAccountUsage({ registerUsageSource: source => { registered.source = source; } });
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), authorization: init.headers?.Authorization, accountId: init.headers?.['ChatGPT-Account-Id'] });
    const body = String(url).endsWith('/chatpass/apps') ? { items: [{ id: 'native-client', windows: [{ used_percent: 5, limit_window_seconds: 3600 }] }] }
      : { plan_type: 'synthetic', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 3600, reset_at: 2000000000 } } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const scope = model => ({ kind: 'session', provider: 'pi', model, env: { PASEO_AGENT_ID: 'agent', PI_CODING_AGENT_DIR: dir, HOME: rootDir } });
  const discover = async model => { snapshotIndex = 0; return (await registered.source.discover(scope(model)))[0]; };
  const fetchUsage = input => registered.source.fetch(input);
  return { rootDir, server, oldFetch, calls, codexAccess: codexCred.access, companionAccess: auth['openai-codex'].access, discover, fetchUsage, close: async () => { globalThis.fetch = oldFetch; server.close(); await rm(rootDir, { recursive: true, force: true }); } };
}

test('standalone named and default Codex fetch use Codex grant with no OpenAI companion traffic', async t => {
  for (const defaultSelected of [false, true]) {
    const f = await fixture({ defaultSelected }); t.after(f.close);
    const item = await f.discover('openai-codex/gpt-test');
    const report = await f.fetchUsage(item.input);
    assert.equal(report.status, 'available', JSON.stringify({ report, calls: f.calls, input: item.input }));
    assert.deepEqual(f.calls.map(call => call.url), ['https://chatgpt.com/backend-api/wham/usage']);
    assert.equal(item.key, identity('openai-codex', 'same-name', 'work-subject'));
  }
});

test('same-name OpenAI and Codex bindings retain isolated discover handles and quota cache keys', async t => {
  const f = await fixture({ includeOpenai: true }); t.after(f.close);
  const codex = await f.discover('openai-codex/gpt-test');
  const openai = await f.discover('openai/gpt-test');
  assert.notEqual(codex.key, openai.key);
  assert.equal((await f.fetchUsage(codex.input)).status, 'available');
  assert.equal((await f.fetchUsage(openai.input)).status, 'available');
  assert.equal(f.calls.filter(call => call.url.endsWith('/backend-api/wham/usage')).length, 2);
  assert.ok(f.calls.some(call => call.url === 'https://chatgpt.com/backend-api/wham/usage/chatpass/apps'));
  const direct = f.calls.find(call => call.url === 'https://chatgpt.com/backend-api/wham/usage' && call.authorization === `Bearer ${f.codexAccess}`);
  assert.ok(direct, 'Codex model must send selected Work Codex grant');
  const companion = f.calls.filter(call => call.url.includes('/chatpass/apps') || (call.url === 'https://chatgpt.com/backend-api/wham/usage' && call !== direct));
  assert.ok(companion.length >= 2 && companion.every(call => call.authorization === `Bearer ${f.companionAccess}`), 'OpenAI companion uses configured matching companion authentication, not Work Codex inference grant');
});

test('Codex refuses missing/wrong provider metadata and mismatched account or subject identity', async t => {
  for (const options of [
    { providerMetadata: false },
    { providerMetadata: true, supported: false },
    { providerMetadata: true, snapshots: [{ providerId: 'openai' }] },
    { reportedSubject: 'other-subject' },
    { reportedAccount: 'other-account' },
  ]) {
    const f = await fixture(options); t.after(f.close);
    const item = await f.discover('openai-codex/gpt-test');
    assert.equal(item.label, undefined, JSON.stringify(options));
    assert.notEqual((await f.fetchUsage(item.input)).status, 'available');
    assert.deepEqual(f.calls, []);
  }
});

test('OpenAI rejects an explicitly mismatched provider even if native registration metadata is present', async t => {
  const f = await fixture({ includeOpenai:true, snapshots:[{providerId:'openai-codex'}] }); t.after(f.close);
  const item = await f.discover('openai/gpt-test');
  assert.notEqual((await f.fetchUsage(item.input)).status,'available');
  assert.deepEqual(f.calls,[]);
});

test('stale Codex selection revision/session changes invalidate usage after discovery', async t => {
  for (const mutation of [{ selectionRevision: 4 }, { sessionId: 'other-session' }]) {
    const f = await fixture({ snapshots: [{}, {}, mutation] }); t.after(f.close);
    const item = await f.discover('openai-codex/gpt-test');
    assert.notEqual((await f.fetchUsage(item.input)).status, 'available');
    if (mutation.sessionId) assert.deepEqual(f.calls, []);
  }
});
