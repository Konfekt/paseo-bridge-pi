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
const text = node => typeof node === 'string' ? node : nodes(node).flatMap(n => [n.props?.children].flat(Infinity).filter(value => typeof value === 'string')).join(' ');

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

test('compiled Work uses one workspace tab, source-scoped persistent UI, and UI-only close', async t => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: fileURLToPath(new URL('../index.client.tsx', import.meta.url)) });
  const { defineSettings } = await import(pathToFileURL(require.resolve('@getpaseo/plugin')));
  const ui = renderer();
  const calls = [], queries = [];
  let settings = { status: 'loading' };
  let settingsContract;
  let rpcResponse = async () => ({ available: false });
  let workAgents;
  let workJobs = [], foregroundJobs = [];
  let conversationError = false;
  let messages = [{ id: 'm1', role: 'assistant', text: 'Worker transcript evidence' }];
  let statusError = false;
  const pillUpdates = [];
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: contract => contract, defineSettings };
    if (name === '@getpaseo/plugin/client') return { useSettings: contract => { settingsContract = contract; return settings; }, useRpc: contract => async input => { calls.push({ name: contract.name, input }); return {}; } };
    if (name === '@getpaseo/plugin/client/ui') return { SettingsAction: 'SettingsAction', SettingsSection: 'SettingsSection', SettingsRow: 'SettingsRow', SettingsToggle: 'SettingsToggle' };
    if (name === '@getpaseo/plugin/client/react-native') return { ScrollView: 'ScrollView', Icon: 'Icon', TextInput: 'TextInput' };
    if (name === 'react-native') return { ActivityIndicator: 'ActivityIndicator', View: 'View', Text: 'Text', Pressable: 'Pressable',
      Animated: { Value: class { interpolate() { return 'rotation'; } }, View: 'AnimatedView' },
      Easing: { linear: value => value },
      AccessibilityInfo: { isReduceMotionEnabled: async () => true, addEventListener: () => ({ remove() {} }) },
    };
    if (name === 'react/jsx-runtime') return { jsx: ui.jsx, jsxs: ui.jsx, Fragment: 'Fragment' };
    if (name === 'react') return { Fragment: 'Fragment', ...ui.hooks, useLayoutEffect: ui.hooks.useEffect, createElement: (type, props, ...children) => ui.jsx(type, { ...props, ...(children.length ? { children } : {}) }, props?.key) };
    if (name === '@tanstack/react-query') return { useQuery(options) {
      queries.push(options);
      const key = options.queryKey;
      const data = workAgents === undefined ? (key[0] === 'harness-status' ? { available: false } : undefined)
        : key[0] === 'harness-status' ? { available: true, sessionId: 's', runtimeEpoch: 'e' }
        : key[0] === 'harness-list' ? { state: 'available', items: key[1] === 'subagents' ? workAgents : workJobs }
        : key[0] === 'harness-detail' ? { state: 'available', item: { text: 'Owned grandchild job output', truncated: false } }
        : key[0] === 'foreground-tasks' ? { available: true, tasks: foregroundJobs }
        : key[0] === 'worker-conversation' ? { state: 'available', item: { messages, nextCursor: 2, execution: 'running', liveText: 'Streaming assistant delta', liveEvents: [{ sequence: 3, kind: 'tool_end', toolCallId: 'call-1', name: 'bash', status: 'completed', arguments: { command: 'git status --short', private: 'ARGUMENT_SECRET' }, result: 'LIVE_RESULT_SECRET' }] } }
        : undefined;
      return { data, isPending: false, isError: (key[0] === 'worker-conversation' && conversationError) || (key[0] === 'harness-status' && statusError), refetch() {} };
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
      addComposerPill: pill => { const registration = { ...pill, update(value) { pillUpdates.push(value); }, remove() { this.removed = true; } }; pills.push(registration); return registration; },
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
    const icon = pill(first, 'a').button.icon;
    const iconProps = { ...props, context: 'agent', agentId: 'a', size: 16, color: '#fff' };
    workAgents = [
      { taskId: 'running', status: 'running', reaped: false },
      ...Array.from({ length: 4 }, (_, i) => ({ taskId: `idle-${i}`, status: 'completed', reaped: false })),
      { taskId: 'reaped', status: 'completed', reaped: true },
    ];
    let indicator = ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, '1 working', 'spinner counts only running agents, not four retained idle agents');
    assert.ok(!nodes(indicator).some(n => n.props?.accessibilityLabel === 'Idle agents'));
    workAgents[0].status = 'completed';
    indicator = ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, 'Work', 'idle agents do not advertise execution');
    assert.ok(!nodes(indicator).some(n => n.props?.accessibilityLabel === 'Idle agents'));
    workJobs = [{ id: 'job-running', status: 'running' }, { id: 'job-done', status: 'completed' }];
    indicator = ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, '1 job', 'running job outranks five idle subagents');
    workJobs.push({ jobId: 'grandchild-indicator', status: 'running', fromSubagent: true });
    ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, '2 jobs', 'verified descendant jobs count in the same top-level indicator');
    workJobs.pop();
    assert.ok(!nodes(indicator).some(n => n.props?.accessibilityLabel === 'Idle agents'));
    foregroundJobs = [{ taskId: 'foreground-running', status: 'running' }];
    ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, '2 jobs', 'running foreground work is included');
    workAgents[0].status = 'pending';
    workAgents[1].status = 'starting';
    ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, '2 working', 'running subagents outrank running jobs');
    workAgents[0].status = 'completed';
    workAgents[1].status = 'completed';
    workJobs = []; foregroundJobs = [];
    indicator = ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, 'Work', 'idle agents stay unobtrusive after jobs finish');
    assert.ok(!nodes(indicator).some(n => n.props?.accessibilityLabel === 'Idle agents'));
    workAgents = [];
    ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, 'Work');
    workAgents = undefined;
    ui.unmount();
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
    const jobsAction = nodes(tree).find(node => node.type === 'SettingsAction' && node.props.actionLabel === 'Completed');
    assert.ok(jobsAction, 'Jobs uses the host SettingsAction via shared WorkAction');
    assert.equal(jobsAction.props.style, undefined, 'Jobs action has no custom button styling');
    workAgents = [];
    workJobs = [
      { jobId: 'job-grandchild', name: 'Grandchild fixture', status: 'running', createdAt: '2026-01-01', updatedAt: null, observationOnly: false, fromSubagent: true },
      { jobId: 'job-direct', name: 'Direct fixture', status: 'running', createdAt: '2026-01-01', updatedAt: null, observationOnly: false },
      { jobId: 'job-child', name: 'Child fixture', status: 'running', createdAt: '2026-01-01', updatedAt: null, observationOnly: true, fromSubagent: true },
    ];
    tree = render();
    assert.equal(nodes(tree).filter(node => node.props?.accessibilityRole === 'header' && node.props.children === 'From subagents').length, 1);
    assert.ok(text(tree).indexOf('Direct fixture') < text(tree).indexOf('From subagents'), 'direct jobs retain their first section');
    assert.ok(text(tree).indexOf('Grandchild fixture') > text(tree).indexOf('From subagents'));
    const grandchild = nodes(tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel?.startsWith('Grandchild fixture'));
    assert.ok(grandchild, 'same existing job row is used'); grandchild.props.onPress(); tree = render();
    assert.match(text(tree), /Owned grandchild job output/);
    assert.equal(nodes(tree).find(node => node.type === 'Text' && node.props.children === 'Owned grandchild job output').props.style.fontFamily, 'monospace');
    assert.ok(!nodes(tree).some(node => /cancel|signal|reap/i.test(node.props?.accessibilityLabel ?? '')), 'jobs remain read-only');
    workJobs = [];
    workAgents = undefined;
    scroll(tree).props.onScroll({ nativeEvent: { contentOffset: { y: 321 } } });
    tree = render();
    assert.equal(scroll(tree).props.contentOffset.y, 321, 'status/query rerenders must not reset a mounted scroll position');
    click(first, 'a'); tree = render();
    assert.equal(selected(tree), 'Goals', 'new source does not inherit another source section');
    assert.match(text(tree), /Conversation A/);
    select(tree, 'Agents'); tree = render();
    const agentsAction = nodes(tree).find(node => node.type === 'SettingsAction' && node.props.actionLabel === 'Completed');
    assert.ok(agentsAction, 'Agents uses the host SettingsAction via shared WorkAction');
    assert.equal(agentsAction.type, jobsAction.type);
    assert.deepEqual(Object.keys(agentsAction.props).sort(), Object.keys(jobsAction.props).sort());
    assert.equal(agentsAction.props.style, undefined);
    workAgents = [
      ...Array.from({ length: 5 }, (_, i) => ({ taskId: `task-${i}`, childId: `child-${i}`, title: `Worker ${i}`, status: i < 3 ? 'completed' : 'running', reaped: false, attempt: 1, runtimeId: `runtime-${i}` })),
      { taskId: 'old-task', childId: 'old-child', title: 'Old worker', status: 'completed', reaped: true, attempt: 1, runtimeId: null },
    ];
    tree = render();
    const rows = tree => nodes(tree).filter(n => n.type === 'Pressable' && /^(Worker \d|Old worker|Helper) ·/.test(n.props?.accessibilityLabel ?? ''));
    assert.equal(rows(tree).length, 5);
    const desktopStyle = Object.assign({}, ...rows(tree)[0].props.style({ pressed: false }));
    assert.equal(desktopStyle.gap, 6);
    assert.equal(desktopStyle.paddingHorizontal, 12);
    assert.equal(desktopStyle.paddingVertical, 8);
    assert.equal(desktopStyle.minHeight, 44);
    tree = render(first, { layout: { platform: 'web', compact: true } });
    assert.equal(Object.assign({}, ...rows(tree)[0].props.style({})).minHeight, 44);
    tree = render();
    assert.equal(nodes(tree).find(n => n.type === 'SettingsAction').props.label, '');
    assert.equal(rows(tree).filter(n => n.props.accessibilityLabel.includes('Idle')).length, 3);
    assert.ok(!text(tree).includes('Old worker'));
    assert.equal(first.screens.length, 0);
    assert.equal(calls.filter(c => c.name === 'independent_agent_open').length, 0);
    rows(tree)[0].props.onPress(); tree = render();
    assert.match(text(tree), /Worker transcript evidence/);
    assert.equal(rows(tree).length, 5, 'historical inline expansion retains the identical list');
    assert.equal(nodes(tree).filter(n => n.props?.testID === 'work-agent-detail').length, 0, 'no new detail screen');
    assert.ok(nodes(tree).some(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Open child chat'), 'historical chat button retained');
    const liveQuery = queries.find(q => q.queryKey[0] === 'worker-conversation');
    assert.equal(liveQuery.refetchInterval, 1200);
    assert.equal(liveQuery.refetchOnReconnect, true);
    assert.ok(!queries.some(q => q.queryKey[0] === 'harness-detail' && q.enabled), 'live log replaces final-report reads');
    workAgents[0].status = 'running';
    messages = [...messages, { id: 'm2', role: 'tool', text: 'Live tool execution evidence' }];
    tree = render();
    assert.doesNotMatch(text(tree), /Live tool execution evidence/, 'tool output never leaks into the collapsed label');
    assert.ok(nodes(tree).some(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Tool Tool · unknown'), 'unmatched result remains an honest collapsed tool badge');
    assert.equal(nodes(tree).filter(n => n.props?.testID === 'work-agent-conversation').length, 1);
    assert.ok(nodes(tree).some(n => n.type === 'ScrollView' && n.props.style?.maxHeight === 320), 'bounded native timeline retained');
    assert.match(text(tree), /Streaming assistant delta/);
    assert.ok(nodes(tree).some(n => n.type === 'ActivityIndicator' && n.props.accessibilityLabel === 'Assistant is working'), 'spinner appears only from authoritative running state');
    assert.doesNotMatch(text(tree), /Working…|retained snapshot/i);
    messages = [
      { id: 'call-row', role: 'assistant', text: 'Checking **the current state** with `git`.', parts: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'git status --short', private: 'ARGUMENT_SECRET' }, status: 'completed', result: 'RESULT_SECRET' }] },
      { id: 'result-row', role: 'tool', toolCallId: 'call-1', toolName: 'bash', status: 'completed', text: 'RESULT_SECRET' },
      { id: 'markdown-row', role: 'assistant', text: '# Summary\n\nA **formatted** paragraph with `inline code`.\n\n- one list item\n\n3. First numbered item.\n4. Second numbered item.' },
      { id: 'parent-row', role: 'parent', text: 'Please **review** this request. Use notify_parent then task_outcome; preserve _one_two_ as emphasis.' },
    ];
    tree = render();
    const timeline = nodes(tree).find(n => n.type === 'ScrollView' && n.props.style?.maxHeight === 320);
    assert.equal(timeline.props.contentContainerStyle.gap ?? 0, 0, 'timeline does not insert gaps for invisible correlated result rows');
    assert.ok(!nodes(tree).some(n => n.key === 'result-row'), 'correlated tool results have no empty layout wrapper');
    assert.ok(nodes(tree).filter(n => n.type === 'View' && n.props.style?.marginHorizontal === -13).every(n => !n.props.style.marginBottom), 'collapsed tool badges have no extra inter-row margin');
    assert.match(text(tree), /git status --short/, 'badge uses the compact native command summary');
    assert.match(text(tree), /formatted/, 'assistant prose is rendered through the Markdown adapter');
    assert.ok(nodes(tree).some(n => n.props?.testID === 'transcript-markdown'));
    assert.ok(nodes(tree).some(n => n.type === 'p' && n.props.style.fontSize === 15 && n.props.style.lineHeight === '21px'), 'body matches native content typography');
    assert.ok(nodes(tree).some(n => n.type === 'h1' && n.props.style.fontSize === 24 && n.props.style.lineHeight === '31px'), 'heading follows native content scale');
    assert.ok(nodes(tree).some(n => n.type === 'code' && n.props.style.fontSize === 12), 'inline code matches native code size');
    assert.ok(nodes(tree).some(n => n.type === 'strong'), 'web markdown keeps strong semantics');
    assert.match(text(tree), /notify_parent then task_outcome/, 'native/CommonMark intraword underscores preserve literal tool identifiers');
    assert.ok(nodes(tree).some(n => n.type === 'em' && text(n).includes('one_two')), 'underscore emphasis still works around identifiers');
    assert.ok(nodes(tree).some(n => n.type === 'code'), 'web markdown keeps inline code semantics');
    assert.ok(nodes(tree).some(n => n.type === 'ul' && nodes(n).some(child => child.type === 'li')), 'web markdown keeps list semantics');
    const orderedList = nodes(tree).find(n => n.type === 'ol');
    assert.equal(orderedList?.props.start, 3, 'numbered lists preserve their starting ordinal rather than becoming bullets');
    const orderedItems = nodes(orderedList).filter(n => n.type === 'li');
    assert.equal(orderedItems.length, 2, 'consecutive numbered items share one native-spaced list block');
    assert.deepEqual(orderedItems.map(n => n.props.style.marginBottom), [4, 0], 'native list item spacing is4px, with no extra per-item block gap');
    assert.ok(nodes(tree).some(n => n.type === 'View' && n.props.style?.alignSelf === 'flex-end'), 'parent input uses the native user-message bubble treatment');
    assert.equal(nodes(tree).filter(n => n.type === 'Text' && n.props.children === 'parent').length, 0, 'no separate parent role label');
    assert.doesNotMatch(text(tree), /ARGUMENT_SECRET|RESULT_SECRET|LIVE_RESULT_SECRET/, 'correlated tool results and full arguments stay inside the collapsed badge');
    const toolBadge = nodes(tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Tool Shell · git status --short · completed');
    assert.ok(toolBadge, 'badge uses native icon/name/summary presentation');
    assert.equal(toolBadge.props.accessibilityState.expanded, false, 'tool details start collapsed');
    assert.equal(nodes(toolBadge).filter(n => n.type === 'Icon').length, 1, 'native collapsed badges have one leading icon, no trailing check/chevron clutter');
    assert.ok(nodes(toolBadge).some(n => n.type === 'Icon' && n.props.name === 'SquareTerminal' && n.props.size === 12));
    let automaticScrolls = 0;
    timeline.props.ref.current = { scrollToEnd() { automaticScrolls++; } };
    toolBadge.props.onPress(); tree = render();
    nodes(tree).find(n => n.type === 'ScrollView' && n.props.style?.maxHeight === 320).props.onContentSizeChange();
    assert.equal(automaticScrolls, 0, 'expanding earlier tool details preserves the reading anchor instead of snapping to the live tail');
    timeline.props.ref.current = null;
    assert.match(text(tree), /ARGUMENT_SECRET/);
    assert.match(text(tree), /LIVE_RESULT_SECRET/, 'newer live completion overlays the persisted call and reveals its result only on click');
    assert.doesNotMatch(text(tree), /"result": "RESULT_SECRET"/, 'stale persisted result is superseded by the latest correlated live result');
    assert.ok(nodes(tree).some(n => n.type === 'Icon' && n.props.name === 'ChevronDown'), 'expanded badge replaces its leading tool icon with the native disclosure');
    nodes(tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Older messages').props.onPress(); tree = render();
    assert.equal(queries.find(q => q.queryKey[0] === 'worker-conversation').queryKey.at(-1), 2);
    workAgents[0].status = 'completed'; tree = render();
    assert.equal(queries.find(q => q.queryKey[0] === 'worker-conversation').queryKey.at(-1), 2, 'settlement does not reset history pagination');
    nodes(tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Latest messages').props.onPress(); tree = render();
    assert.equal(queries.find(q => q.queryKey[0] === 'worker-conversation').queryKey.at(-1), undefined);
    assert.equal(calls.filter(c => c.name === 'independent_agent_open').length, 0, 'row click only reads transcript');
    workAgents[0].status = 'completed';
    rows(tree)[0].props.onPress(); tree = render();
    assert.equal(rows(tree).length, 5);
    assert.doesNotMatch(text(tree), /Worker transcript evidence/);
    assert.ok(!queries.some(q => q.queryKey[0] === 'worker-conversation'), 'collapse stops transcript polling');
    rows(tree)[0].props.onPress(); tree = render();
    conversationError = true; tree = render();
    assert.match(text(tree), /Conversation unavailable/);
    assert.doesNotMatch(text(tree), /Worker transcript evidence/, 'errors do not present stale transcript');
    conversationError = false;
    statusError = true; tree = render();
    assert.doesNotMatch(text(tree), /Worker transcript evidence/, 'unavailable source hides retained detail');
    assert.equal(rows(tree).length, 0);
    statusError = false; tree = render();
    nodes(tree).find(n => n.type === 'SettingsAction' && n.props.actionLabel === 'Completed').props.onPress();
    tree = render();
    assert.equal(rows(tree).length, 1);
    assert.match(text(tree), /Old worker/);
    assert.match(rows(tree)[0].props.accessibilityLabel, /Completed/);
    assert.ok(nodes(tree).some(n => n.props?.style?.borderWidth === 1 && n.props?.style?.borderRadius === 8), 'historical completed card restored');
    rpcResponse = async contract => contract.name === 'harness_status'
      ? { available: true, sessionId: 's', runtimeEpoch: 'e' } : { agentId: 'history-child' };
    rows(tree)[0].props.onPress();
    await new Promise(resolve => setImmediate(resolve));
    tree = render();
    assert.doesNotMatch(text(tree), /Worker transcript evidence/, 'completed click retains historical direct-chat behavior');
    assert.deepEqual(first.screens.at(-1), { screenId: 'independent-conversation', params: { agentId: 'history-child' } });
    assert.equal(calls.filter(c => c.name === 'independent_agent_open').length, 1);
    calls.length = 0; first.screens.length = 0;
    select(tree, 'Agents');
    workAgents = undefined;
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
    workAgents = [{ taskId: 'task', childId: 'child', title: 'Helper', status: 'completed', reaped: false, attempt: 1, runtimeId: 'runtime' }];
    messages = [{ id: 'm1', role: 'assistant', text: 'Worker transcript evidence' }];
    rpcResponse = async contract => contract.name === 'harness_status'
      ? { available: true, sessionId: 's', runtimeEpoch: 'e' }
      : { agentId: 'real-child-agent' };
    tree = render(); select(tree, 'Agents'); tree = render();
    rows(tree)[0].props.onPress(); tree = render();
    const continuation = () => nodes(tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Open child chat');
    for (const status of ['pending', 'launching', 'starting', 'running', 'waiting', 'lost']) {
      workAgents[0].status = status; tree = render();
      assert.match(text(tree), /Worker transcript evidence/, `${status} transcript remains viewable`);
      assert.equal(continuation().props.disabled, true, status);
      continuation().props.onPress();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.filter(c => c.name === 'independent_agent_open').length, 0, `${status} cannot dispatch`);
    }
    for (const status of ['failed', 'cancelled', 'completed']) {
      workAgents[0].status = status; tree = render();
      assert.equal(continuation().props.disabled, false, `${status} checkpoint can be checked by server`);
    }
    workAgents[0].needsAttention = true; tree = render();
    assert.equal(continuation().props.disabled, true, 'unresolved interaction is not eligible');
    continuation().props.onPress();
    assert.equal(calls.filter(c => c.name === 'independent_agent_open').length, 0);
    workAgents[0].needsAttention = false; tree = render();
    const continueButton = continuation();
    assert.ok(continueButton, 'interactive continuation is explicit in the rendered conversation');
    continueButton.props.onPress();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.filter(c => c.name === 'independent_agent_open').length, 1);
    assert.deepEqual(first.screens.at(-1), { screenId: 'independent-conversation', params: { agentId: 'real-child-agent' } }, 'existing verified conversation helper owns native conversation navigation');
    ui.componentProps.get('WorkOverview').openWorkspace('native-workspace');
    assert.deepEqual(first.screens.at(-1), { screenId: 'independent-conversation', params: { workspaceId: 'native-workspace', serverId: 'host' } });
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'a' } }));
    assert.match(text(render()), /Select Work/, 'removed source invalidates binding');
    assert.equal(queries.length, 0);
    assert.equal(first.screens.length, 2, 'only explicit user navigation opens the native navigation screen');
    assert.ok(calls.every(call => !/cancel|stop|reap|close/.test(call.name)));

    // Full refresh: contribution, subscriptions and hook state are all recreated.
    // Only the host's supported settings document survives.
    ui.unmount();
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const persisted = { hostId: 'host', workspaceId: 'w', agentId: 'a', sessionId: 's' };
    settings = {
      status: 'ready', values: { sources: [] }, revision: '0',
      async save(values, revision) {
        assert.equal(revision, this.revision);
        this.values = settingsContract.schema.parse(values);
        this.revision = String(Number(this.revision) + 1);
        return true;
      },
      async reload() {},
    };
    const writer = host(); await tick(); snapshot(writer);
    click(writer, 'a'); render(writer); await tick();
    assert.equal(settingsContract.id, 'work-source');
    assert.equal(settingsContract.scope, 'host');
    assert.deepEqual(settings.values.sources, [persisted]);
    ui.unmount(); writer.cleanup();
    assert.deepEqual(settings.values.sources, [persisted], 'teardown does not erase restoration hints');
    for (const scenario of ['valid', 'removed', 'archived', 'wrong-workspace', 'wrong-provider', 'dormant', 'stale-host', 'stale-session']) {
      settings.values = { sources: [{ ...persisted, ...(scenario === 'stale-host' ? { hostId: 'old-host' } : {}) }] };
      const cold = host(); await tick();
      try {
        render(cold); await tick();
        assert.match(text(render(cold)), /Select Work/, 'wait for subscription hydration');
        assert.deepEqual(settings.values.sources[0].agentId, 'a', 'delayed snapshot does not discard saved hint');
        const source = { ...agents[0],
          ...(scenario === 'archived' ? { archivedAt: 'now' } : {}),
          ...(scenario === 'wrong-workspace' ? { workspaceId: 'other' } : {}),
          ...(scenario === 'wrong-provider' ? { provider: 'other' } : {}),
          ...(scenario === 'dormant' ? { runtimeInfo: { extra: { independentDormant: true } } } : {}),
        };
        rpcResponse = async () => ({ available: true, sessionId: scenario === 'stale-session' ? 'replacement' : 's', runtimeEpoch: 'reconnected' });
        cold.observers.forEach(observer => observer.snapshot({ entries: (scenario === 'removed' ? [agents[1]] : [source, agents[1]]).map(agent => ({ agent })) }));
        render(cold); await tick();
        const restoredTree = render(cold);
        if (scenario === 'valid') {
          assert.match(text(restoredTree), /Conversation A/);
          settings.values = { sources: [{ ...persisted, agentId: 'b' }] };
          render(cold); await tick();
          assert.match(text(render(cold)), /Conversation A/, 'another client cannot live-switch an active source');
          ui.unmount();
          assert.match(text(render(cold)), /Conversation A/, 'UI-only close preserves local source');
          cold.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'a' } }));
          assert.match(text(render(cold)), /Select Work/);
        } else {
          assert.match(text(restoredTree), /Select Work/, scenario);
          assert.equal(queries.length, 0, 'invalid hint never queries another agent');
          settings.values = { sources: [{ ...persisted, agentId: 'b' }] };
          render(cold); await tick();
          assert.match(text(render(cold)), /Select Work/, 'invalid hint cannot fall through to a later unrelated hint');
        }
      } finally { ui.unmount(); cold.cleanup(); }
    }
    // Settings themselves can arrive after the inventory; do not claim an
    // empty/default preference before the supported hook reports ready.
    const readySettings = settings;
    settings = { status: 'loading' };
    const delayedSettings = host(); await tick(); snapshot(delayedSettings);
    assert.match(text(render(delayedSettings)), /Select Work/);
    settings = readySettings; settings.values = { sources: [persisted] };
    rpcResponse = async () => ({ available: true, sessionId: 's', runtimeEpoch: 'e' });
    render(delayedSettings); await tick();
    assert.match(text(render(delayedSettings)), /Conversation A/);
    ui.unmount(); delayedSettings.cleanup();

    // Removal while validating identity must not restore a now-invalid source.
    const removedPending = host(); await tick(); snapshot(removedPending);
    let releaseRemoved;
    rpcResponse = () => new Promise(resolve => { releaseRemoved = resolve; });
    render(removedPending);
    removedPending.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'a' } }));
    releaseRemoved({ available: true, sessionId: 's', runtimeEpoch: 'e' });
    await tick();
    assert.match(text(render(removedPending)), /Select Work/);
    ui.unmount(); removedPending.cleanup();

    // Reconnect can hydrate the inventory before the Pi session is available.
    // Retain the precise hint while offline and retry, without choosing B.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    settings.values = { sources: [persisted] };
    const reconnecting = host(); await tick(); snapshot(reconnecting);
    rpcResponse = async () => ({ available: false });
    render(reconnecting); await tick();
    assert.match(text(render(reconnecting)), /Select Work/);
    rpcResponse = async () => ({ available: true, sessionId: 's', runtimeEpoch: 'new-epoch' });
    t.mock.timers.tick(5000); await tick();
    assert.match(text(render(reconnecting)), /Conversation A/);
    ui.unmount(); reconnecting.cleanup();
    t.mock.timers.reset();

    // An explicit click wins even when a saved source's identity RPC is in flight.
    settings.values = { sources: [persisted] };
    const racing = host(); await tick(); snapshot(racing);
    let releaseRestore;
    rpcResponse = () => new Promise(resolve => { releaseRestore = resolve; });
    render(racing);
    click(racing, 'b');
    releaseRestore({ available: true, sessionId: 's', runtimeEpoch: 'e' });
    await tick();
    rpcResponse = async () => ({ available: true, sessionId: 'b-session', runtimeEpoch: 'e' });
    assert.match(text(render(racing)), /Conversation B/);
    await tick();
    assert.equal(settings.values.sources[0].agentId, 'b');
    ui.unmount(); racing.cleanup();

    settings.values = { sources: [persisted] };
    const removedExplicit = host(); await tick(); snapshot(removedExplicit);
    rpcResponse = () => new Promise(resolve => { releaseRestore = resolve; });
    render(removedExplicit);
    click(removedExplicit, 'b');
    removedExplicit.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'b' } }));
    releaseRestore({ available: true, sessionId: 's', runtimeEpoch: 'e' });
    await tick();
    assert.match(text(render(removedExplicit)), /Select Work/, 'removal of an explicitly selected source cannot revive an older pending restore');
    ui.unmount(); removedExplicit.cleanup();
  } finally { ui.unmount(); first.cleanup(); second.cleanup(); }
});
