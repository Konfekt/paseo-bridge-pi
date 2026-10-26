import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiler = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler, 'PASEO_PLUGIN_COMPILER is required');
const require = createRequire(resolve(compiler));
const root = await mkdtemp(resolve(tmpdir(), 'chat-account-controls-'));
after(() => rm(root, { recursive: true, force: true }));
for (const dir of ['client', 'shared']) await cp(fileURLToPath(new URL(`../${dir}`, import.meta.url)), resolve(root, dir), { recursive: true });
await writeFile(resolve(root, 'index.client.tsx'), 'export { contributeChatAccountControls } from "./client/account-controls"; export { contributeHarness } from "./client/harness"; export { contributeBtw } from "./client/btw";');
const { compilePlugin } = await import(pathToFileURL(resolve(compiler)));
const { clientBundle } = await compilePlugin({ client: resolve(root, 'index.client.tsx') });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('actual composer contribution targets each exact chat, includes background children and rejects context substitution', async () => {
  let observer, options;
  const registrations = [], requests = [], states = [];
  let hook = 0;
  const snapshot = { protocol: 1, serviceEpoch: 'service', selectionRevision: 1, sessionId: 'child-session', accounts: [{ id: 'Work', label: 'Work', authKind: 'oauth' }], currentAccountId: null, defaultSelected: true, busy: false, canSwitch: true, inheritance: 'inherited', usage: { effectiveCredential: 'unknown', settingsUrl: null } };
  let statusResult = { available: false, sessionId: null, runtimeEpoch: null, snapshot: null };
  const nodes = x => Array.isArray(x) ? x.flatMap(nodes) : !x || typeof x !== 'object' ? [] : [x, ...nodes(x.props?.children)];
  const text = x => Array.isArray(x) ? x.map(text).join('') : typeof x === 'string' ? x : x && typeof x === 'object' ? text(x.props?.children) : '';
  const jsx = (type, props) => typeof type === 'function' ? type(props ?? {}) : { type, props: props ?? {} };
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: x => x, defineSettings: x => x };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react') return { useEffect() {}, useState(initial) { const i = hook++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; } };
    if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable' };
    if (name === '@getpaseo/plugin/client/ui') return { SettingsSection: 'Section', SettingsCard: 'Card', SettingsSelect: 'Select' };
    if (name === '@getpaseo/plugin/client/react-native') return { ScrollView: 'ScrollView' };
    if (name === '@getpaseo/plugin/client') return { useRpc: contract => async input => { requests.push({ name: contract.name, input }); return contract.name === 'account_controls_status' ? statusResult : { ok: true, requestId: input.request.requestId, snapshot }; } };
    if (name === '@tanstack/react-query') return { useQuery: value => { void value.queryFn(); return { data: statusResult, isPending: !statusResult.available, isFetching: false, isError: false, refetch: async () => ({ data: await value.queryFn(), isError: false }) }; } };
    return require(name);
  };
  const { contributeChatAccountControls } = (0, eval)(clientBundle)(load);
  const client = { paseo: { agents: { list: async input => { options = input; return { subscription: { subscribe: value => { observer = value; } } }; } } }, addComposerPill(input) { const item = { input, removed: false, remove() { this.removed = true; } }; registrations.push(item); return item; } };
  const stop = contributeChatAccountControls(client);
  try {
    await flush();
    assert.equal(options.includeBackground, true);
    const parent = { id: 'parent', provider: 'pi', workspaceId: 'workspace' };
    const child = { ...parent, id: 'child', visibility: 'background' };
    observer.snapshot({ entries: [{ agent: parent }, { agent: child }] });
    assert.deepEqual(registrations.map(r => r.input.agentId), ['parent', 'child']);
    assert.ok(registrations.every(r => r.input.id === 'pi-codex-account'));
    const Content = registrations[1].input.button.behavior.Content;
    const props = { context: 'agent', agentId: 'child', workspaceId: 'workspace', host: { id: 'host' }, theme: { colors: {} } };
    hook = 0; Content(props); await flush();
    assert.deepEqual(requests, [{ name: 'account_controls_status', input: { agentId: 'child', workspaceId: 'workspace', providerId: 'openai-codex' } }]);
    Content({ ...props, agentId: 'parent' }); Content({ ...props, workspaceId: 'other' }); Content({ ...props, context: 'workspace' });
    assert.equal(requests.length, 1, 'substituted popover contexts cannot even query another chat');
    statusResult = { available: true, sessionId: 'child-session', runtimeEpoch: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', snapshot };
    const draw = () => { hook = 0; return nodes(Content(props)); };
    draw(); await flush();
    let all = draw();
    const press = (label) => { const row = all.find(n => n.type === 'Pressable' && text(n) === label); assert.ok(row, `missing ${label}`); assert.ok(!row.props.disabled); row.props.onPress(); };
    snapshot.currentAccountId = 'Work'; snapshot.defaultSelected = false; all = draw();
    press('Work'); all = draw(); press('Confirm switch'); await flush(); await flush();
    assert.equal(requests.filter(r => r.name === 'account_controls_switch').at(-1).input.request.accountId, 'Work', 'same inherited account can be frozen as a local explicit override');
    snapshot.currentAccountId = null; snapshot.defaultSelected = true; all = draw();
    press('Use Pi built-in login'); all = draw(); press('Confirm switch'); await flush(); await flush();
    const explicit = requests.filter(r => r.name === 'account_controls_switch').at(-1).input;
    assert.equal(explicit.agentId, 'child'); assert.equal(explicit.workspaceId, 'workspace');
    assert.equal(explicit.request.expectedSessionId, 'child-session'); assert.equal(explicit.request.providerId, 'openai-codex');
    assert.equal(explicit.request.accountId, null); assert.equal(explicit.request.inherit, undefined, 'built-in login is explicit, not clear');
    snapshot.inheritance = 'explicit'; all = draw(); press('Follow parent account'); all = draw(); press('Confirm switch'); await flush(); await flush();
    const clear = requests.filter(r => r.name === 'account_controls_switch').at(-1).input;
    assert.equal(clear.agentId, 'child'); assert.equal(clear.request.inherit, true); assert.equal(clear.request.accountId, null);
    observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...child, workspaceId: 'new-workspace' } } });
    assert.equal(registrations[1].removed, true);
    assert.equal(registrations[2].input.workspaceId, 'new-workspace');
    assert.equal(child.visibility, 'background', 'registration never promotes background chats');
  } finally { stop(); }
  assert.equal(options.signal.aborted, true);
  assert.ok(registrations.every(r => r.removed));
});

test('Work and BTW register current and newly observed background Pi children without promotion', async () => {
  const observers = [], pills = [];
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: x => x, defineSettings: x => x };
    if (['react', 'react/jsx-runtime', 'react-native', '@getpaseo/plugin/client', '@getpaseo/plugin/client/ui', '@getpaseo/plugin/client/react-native', '@tanstack/react-query'].includes(name)) return {};
    return require(name);
  };
  const { contributeHarness, contributeBtw } = (0, eval)(clientBundle)(load);
  const client = {
    paseo: { agents: { list: async options => ({ subscription: { subscribe: observer => observers.push({ options, observer }) } }) } },
    rpc: async () => ({}), addScreen: () => () => {}, addWorkspacePanel: () => () => {}, openPanel() {},
    addComposerPill(input) { const pill = { ...input, removed: false, update() {}, remove() { this.removed = true; } }; pills.push(pill); return pill; },
  };
  const stopWork = contributeHarness(client), stopBtw = contributeBtw(client);
  try {
    await flush();
    const current = Object.freeze({ id: 'current-background-child', workspaceId: 'workspace', provider: 'pi', visibility: 'background' });
    for (const { options, observer } of observers) observer.snapshot({ entries: options.includeBackground ? [{ agent: current }] : [] });
    assert.deepEqual(pills.filter(p => p.agentId === current.id).map(p => p.id).sort(), ['pi-btw', 'work']);
    const future = Object.freeze({ ...current, id: 'new-background-child' });
    for (const { options, observer } of observers) if (options.includeBackground) observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: future } });
    assert.deepEqual(pills.filter(p => p.agentId === future.id).map(p => p.id).sort(), ['pi-btw', 'work']);
    assert.equal(current.visibility, 'background'); assert.equal(future.visibility, 'background');
  } finally { stopBtw(); stopWork(); }
  assert.ok(pills.every(p => p.removed));
  assert.ok(observers.every(({ options }) => options.signal.aborted));
});
