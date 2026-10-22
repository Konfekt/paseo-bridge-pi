import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath, 'Set PASEO_PLUGIN_COMPILER to the installed Paseo compiler; this integration must not silently skip');
// Resolve schema/runtime dependencies from the real host compiler installation,
// not undeclared bridge-local packages. Missing host dependencies must fail.
const require = createRequire(resolve(compilerPath));
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = node => typeof node === 'string' ? node : nodes(node).filter(n => n.type === 'Text').map(n => [n.props.children].flat().filter(v => typeof v === 'string').join('')).join(' ');

// A small host renderer: execute compiled components, keep hook identity by JSX
// key/path, and run real effect setup/cleanup on mount/unmount. No Work logic is
// reproduced here; navigation and RPC are observed host boundaries.
function renderer() {
  let active, cursor;
  const instances = new Map();
  const componentProps = new Map();
  let seen;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in active.slots)) active.slots[i] = typeof initial === 'function' ? initial() : initial;
      const owner = active;
      return [owner.slots[i], value => { owner.slots[i] = typeof value === 'function' ? value(owner.slots[i]) : value; }];
    },
    useRef(initial) { const [ref] = hooks.useState(() => ({ current: initial })); return ref; },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    useEffect(fn, deps) {
      const i = cursor++;
      const previous = active.effects[i];
      if (!previous || !deps || deps.some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.();
        active.effects[i] = { deps, cleanup: fn() };
      }
    },
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  function visit(node, path) {
    if (Array.isArray(node)) return node.map((child, i) => visit(child, `${path}/${child?.key ?? i}`));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      path += `/${node.type.name}:${node.key ?? ''}`;
      seen.add(path);
      componentProps.set(node.type.name, node.props);
      if (!instances.has(path)) instances.set(path, { slots: [], effects: [] });
      active = instances.get(path); cursor = 0;
      return visit(node.type(node.props), path);
    }
    return { ...node, props: { ...node.props, children: visit(node.props.children, `${path}/children`) } };
  }
  function unmount() { for (const instance of instances.values()) instance.effects.forEach(effect => effect.cleanup?.()); instances.clear(); }
  return { hooks, jsx, unmount, componentProps, render(Component, props) {
    seen = new Set();
    const tree = visit(jsx(Component, props), 'root');
    for (const [path, instance] of instances) if (!seen.has(path)) {
      instance.effects.forEach(effect => effect.cleanup?.()); instances.delete(path);
    }
    return tree;
  } };
}

test('compiled Work uses one workspace tab, source-scoped persistent UI, and UI-only close', async () => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: fileURLToPath(new URL('../index.client.tsx', import.meta.url)) });
  const ui = renderer();
  const calls = [], queries = [];
  let rpcResponse = async () => ({ available: false });
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: contract => contract };
    if (name === '@getpaseo/plugin/client') return { useRpc: contract => async input => { calls.push({ name: contract.name, input }); return {}; } };
    if (name === '@getpaseo/plugin/client/ui') return { SettingsAction: 'SettingsAction', SettingsSection: 'SettingsSection', SettingsRow: 'SettingsRow', SettingsToggle: 'SettingsToggle' };
    if (name === '@getpaseo/plugin/client/react-native') return { ScrollView: 'ScrollView', Icon: 'Icon', TextInput: 'TextInput' };
    if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable' };
    if (name === 'react/jsx-runtime') return { jsx: ui.jsx, jsxs: ui.jsx, Fragment: 'Fragment' };
    if (name === 'react') return { ...ui.hooks, createElement: (type, props, ...children) => ui.jsx(type, { ...props, ...(children.length ? { children } : {}) }, props?.key) };
    if (name === '@tanstack/react-query') return { useQuery(options) {
      queries.push(options);
      return { data: options.queryKey[0] === 'harness-status' ? { available: false } : undefined, isPending: false, isError: false, refetch() {} };
    }, useMutation() { return { isPending: false, mutate() { throw Error('Unexpected mutation'); } }; } };
    return require(name);
  };
  const contribute = (0, eval)(clientBundle)(load).default;
  function host() {
    const observers = [], pills = [], panels = [], opened = [], screens = [];
    const cleanup = contribute({
      paseo: { config: { get: async () => ({ config: { plugins: { 'paseo-accounts': { enabled: true } } } }) }, agents: { list: async () => ({ subscription: { subscribe: observer => observers.push(observer) } }) } },
      addScreen: () => () => {}, openScreen: value => screens.push(value),
      addWorkspacePanel: panel => { panels.push(panel); return () => {}; },
      addHeaderButton: () => ({ update() {}, remove() {} }),
      addComposerPill: pill => { const registration = { ...pill, update() {}, remove() { this.removed = true; } }; pills.push(registration); return registration; },
      openPanel: (id, options) => opened.push({ id, options }),
      rpc: async (contract, input) => { calls.push({ name: contract.name, input }); return rpcResponse(contract, input); },
    });
    return { observers, pills, panels, opened, screens, cleanup };
  }
  const first = host(), second = host();
  await new Promise(resolve => setImmediate(resolve));
  const agents = ['a', 'b'].map(id => ({ id, title: `Conversation ${id.toUpperCase()}`, workspaceId: 'w', provider: 'pi' }));
  const snapshot = host => host.observers.forEach(observer => observer.snapshot({ entries: agents.map(agent => ({ agent })) }));
  snapshot(first); snapshot(second);
  const pill = (host, id) => host.pills.find(pill => pill.id === 'work' && pill.agentId === id && !pill.removed);
  const click = (host, id) => { assert.equal(pill(host, id).button.behavior.kind, 'action'); pill(host, id).button.behavior.onPress(); };
  const panel = host => { const work = host.panels.filter(panel => panel.id === 'work'); assert.equal(work.length, 1); assert.equal(work[0].context, 'workspace'); assert.deepEqual(work[0].locations, ['workspace']); return work[0].Component; };
  const props = { context: 'workspace', workspaceId: 'w', host: { id: 'host' }, theme: { colors: { foreground: '#fff', foregroundMuted: '#aaa', surface0: '#111', surface1: '#222', surface2: '#333', border: '#444', statusSuccess: '#0f0', statusWarning: '#fa0', statusDanger: '#f00' } }, layout: { platform: 'web', compact: false } };
  const render = (host = first, overrides = {}) => { queries.length = 0; return ui.render(panel(host), { ...props, ...overrides }); };
  const select = (tree, section) => { const tab = nodes(tree).find(node => node.props?.accessibilityRole === 'tab' && node.props.children?.props?.children === section); assert.ok(tab, section); tab.props.onPress(); };
  const selected = tree => nodes(tree).find(node => node.props?.accessibilityRole === 'tab' && node.props.accessibilityState.selected)?.props.children.props.children;
  const scroll = tree => nodes(tree).find(node => node.type === 'ScrollView');
  try {
    assert.match(text(render()), /Select Work/);
    assert.equal(queries.length, 0, 'unbound native tab never queries an arbitrary agent');
    click(first, 'a'); click(first, 'a'); click(first, 'b');
    assert.deepEqual(first.opened, Array(3).fill({ id: 'work', options: { workspaceId: 'w', location: 'workspace' } }), 'native workspace identity never contains an agent id');
    let tree = render();
    assert.match(text(tree), /Conversation B/);
    const tabNodes = nodes(tree).filter(node => node.props?.accessibilityRole === 'tab');
    assert.equal(tabNodes.length, 4, 'Work retains four native sections at narrow width');
    assert.ok(tabNodes.every(node => (typeof node.props.style === 'function' ? node.props.style({pressed:false}) : node.props.style)?.minHeight >= 44), 'tabs retain accessible touch targets at narrow widths');
    assert.ok(tabNodes.some(node => node.props.accessibilityState?.selected && (typeof node.props.style === 'function' ? node.props.style({pressed:false}) : node.props.style)?.borderBottomWidth === 2), 'selected section has native underline feedback');
    select(tree, 'Jobs'); tree = render();
    scroll(tree).props.onScroll({ nativeEvent: { contentOffset: { y: 321 } } });
    tree = render();
    assert.equal(scroll(tree).props.contentOffset.y, 321, 'status/query rerenders must not reset a mounted scroll position');
    click(first, 'a'); tree = render();
    assert.equal(selected(tree), 'Goals', 'new source does not inherit another source section');
    assert.match(text(tree), /Conversation A/);
    select(tree, 'Agents'); tree = render();
    click(first, 'b'); tree = render();
    assert.equal(selected(tree), 'Jobs'); assert.equal(scroll(tree).props.contentOffset.y, 321);
    const beforeClose = calls.length;
    ui.unmount(); tree = render();
    assert.equal(selected(tree), 'Jobs'); assert.equal(scroll(tree).props.contentOffset.y, 321);
    const restored = [];
    const scroller = scroll(tree).props;
    scroller.ref.current = { scrollTo: options => restored.push(options) };
    scroller.onLayout({ nativeEvent: { layout: { height: 500 } } });
    scroller.onContentSizeChange(800, 100);
    scroller.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
    assert.equal(restored.length, 0, 'loading placeholder cannot accommodate the saved offset');
    scroller.onContentSizeChange(800, 2000);
    assert.deepEqual(restored, [{ y: 321, animated: false }], 'restore after asynchronous content hydrates');
    assert.equal(calls.length, beforeClose, 'unmount/remount has no cancel/reap/stop RPC');
    ui.unmount(); tree = render();
    const userRestores = [];
    const userScroller = scroll(tree).props;
    userScroller.ref.current = { scrollTo: options => userRestores.push(options) };
    userScroller.onLayout({ nativeEvent: { layout: { height: 500 } } });
    userScroller.onContentSizeChange(800, 100);
    userScroller.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
    userScroller.onScrollBeginDrag();
    userScroller.onScroll({ nativeEvent: { contentOffset: { y: 57 } } });
    userScroller.onContentSizeChange(800, 2000);
    assert.deepEqual(userRestores, [], 'intentional user scrolling cancels pending restoration');
    ui.unmount(); tree = render();
    assert.equal(scroll(tree).props.contentOffset.y, 57, 'user position replaces the old restoration target');
    ui.unmount();
    assert.match(text(render(second)), /Select Work/, 'client/host selection is isolated');
    ui.unmount();
    assert.match(text(render(first, { workspaceId: 'elsewhere' })), /Select Work/);
    assert.equal(queries.length, 0);
    tree = render();
    assert.ok(queries.filter(query => query.queryKey[0] === 'harness-status').every(query => query.queryKey.includes('b') && query.queryKey.includes('w')));
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...agents[1], workspaceId: 'new-workspace' } } }));
    assert.match(text(render()), /Select Work/, 'moving source invalidates old workspace binding');
    assert.equal(queries.length, 0);
    click(first, 'a'); render();
    const target = { hostId: 'host', agentId: 'a', workspaceId: 'w', sessionId: 'session', taskId: 'task', childId: 'child', attempt: 1, runtimeId: 'runtime', title: 'Helper' };
    let releaseIdentity;
    rpcResponse = () => new Promise(resolve => { releaseIdentity = resolve; });
    const pendingOpen = ui.componentProps.get('WorkOverview').openConversation(target);
    const rejected = assert.rejects(pendingOpen, /no longer selected/);
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'a' } }));
    releaseIdentity({ available: true, sessionId: 'session', runtimeEpoch: 'epoch' });
    await rejected;
    assert.equal(calls.filter(call => call.name === 'independent_agent_open').length, 0, 'stale source cannot create a child conversation after identity lookup');
    assert.equal(first.screens.length, 0);
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: agents[0] } }));
    click(first, 'a'); render();
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...agents[0], archivedAt: 'now' } } }));
    assert.match(text(render()), /Select Work/, 'archiving source invalidates binding');
    assert.equal(queries.length, 0);
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: agents[0] } }));
    click(first, 'a'); tree = render();
    assert.equal(selected(tree), 'Goals', 'reappearing source starts with fresh UI state');
    rpcResponse = async contract => contract.name === 'harness_status'
      ? { available: true, sessionId: 'session', runtimeEpoch: 'epoch' }
      : { agentId: 'real-child-agent' };
    await ui.componentProps.get('WorkOverview').openConversation(target);
    assert.deepEqual(first.screens.at(-1), { screenId: 'independent-conversation', params: { agentId: 'real-child-agent' } }, 'existing verified conversation helper owns native conversation navigation');
    ui.componentProps.get('WorkOverview').openWorkspace('native-workspace');
    assert.deepEqual(first.screens.at(-1), { screenId: 'independent-conversation', params: { workspaceId: 'native-workspace', serverId: 'host' } });
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'a' } }));
    assert.match(text(render()), /Select Work/, 'removed source invalidates binding');
    assert.equal(queries.length, 0);
    assert.equal(first.screens.length, 2, 'only explicit user navigation opens the native navigation screen');
    assert.ok(calls.every(call => !/cancel|stop|reap|close/.test(call.name)));
  } finally { ui.unmount(); first.cleanup(); second.cleanup(); }
});
