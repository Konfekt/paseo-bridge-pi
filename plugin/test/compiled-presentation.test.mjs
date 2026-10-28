import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath, 'PASEO_PLUGIN_COMPILER is required; native presentation tests must execute');
const require = createRequire(resolve(compilerPath));
const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
const { clientBundle } = await compilePlugin({ client: fileURLToPath(new URL('../client/presentation.tsx', import.meta.url)) });
const jsx = (type, props) => ({ type, props: props ?? {} });
let slots = [], cursor = 0;
const clipboard = [];
const load = name => {
  if (name === 'react') return { useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = value; }]; } };
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable' };
  if (name === '@getpaseo/plugin/client/ui') return { SettingsAction:'SettingsAction' };
  if (name === '@getpaseo/plugin/client/react-native') return { ScrollView: 'ScrollView', copyText: async text => { clipboard.push(text); } };
  return require(name);
};
const components = (0, eval)(clientBundle)(load);
const render = (Component, props, reset = true) => { if (reset) slots = []; cursor = 0; return Component(props); };
const style = value => Object.assign({}, ...[value].flat(Infinity).filter(Boolean));
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : typeof value.type === 'function' ? nodes(value.type(value.props)) : [value, ...nodes(value.props.children)];
test('compiled unsupported Goals shows read-only legacy state and history with reload guidance', async t => {
  const fixture = await mkdtemp(resolve(tmpdir(),'native-goal-row-'));
  t.after(() => rm(fixture,{recursive:true,force:true}));
  const source = fileURLToPath(new URL('../',import.meta.url));
  for (const directory of ['client','shared']) await cp(resolve(source,directory),resolve(fixture,directory),{recursive:true});
  await writeFile(resolve(fixture,'index.client.tsx'),'export { WorkflowsPanel, WorktreesPanel } from "./client/workflows";');
  const {clientBundle} = await compilePlugin({client:resolve(fixture,'index.client.tsx')});
  const reply = {available:true,sessionId:'fixture-session',runtimeEpoch:'fixture-epoch',snapshot:{serviceEpoch:'fixture-service',goal:null,idle:true,busy:false,capabilities:{createPausedGoal:true},completedGoals:[],limits:{},worktrees:[]}};

  const calls=[];
  const localLoad = name => {
    if(name==='react') { const react=load(name); return {...react,useEffect(){},useRef:initial=>react.useState(()=>({current:initial}))[0]}; }
    if(name==='@getpaseo/plugin') return {defineRpc:contract=>contract};
    if(name==='@getpaseo/plugin/client') return {useRpc:contract=>async input=>{calls.push({name:contract.name,input}); return reply;}};
    if(name==='@getpaseo/plugin/client/ui') return {SettingsSection:'SettingsSection',SettingsCard:'SettingsCard',SettingsSelect:'SettingsSelect',SettingsAction:'SettingsAction'};
    if(name==='@getpaseo/plugin/client/react-native') return {ScrollView:'ScrollView',TextInput:'TextInput'};
    if(name==='@tanstack/react-query') return {useQuery:options=>({data:reply,isPending:false,isError:false,isFetching:false,refetch:()=>options.queryFn()})};
    return load(name);
  };
  const {WorkflowsPanel,WorktreesPanel}=(0,eval)(clientBundle)(localLoad);
  const props={agentId:'agent',workspaceId:'workspace',host:{id:'host'},theme:{colors:palettes[0]}};
  slots=[];
  const draw=()=>{cursor=0;return nodes(WorkflowsPanel(props));};
  let all=draw();
  const connect=all.find(n=>n.type==='Pressable' && n.props.accessibilityLabel==='Connect current session');
  assert.ok(connect); connect.props.onPress();
  all=draw();
  const findButton=(items,label)=>items.find(n=>n.type==='Pressable' && n.props.accessibilityLabel===label);
  const assertReadOnly = items => {
    for (const label of ['Create','Pause','Resume','Edit','Clear','Limits','Add subtask'])
      assert.equal(findButton(items,label),undefined,`${label} must not mutate legacy parent goals`);
    assert.equal(items.some(n=>n.type==='TextInput'),false,'legacy goals have no editing fields');
    assert.ok(items.some(n=>n.type==='Text' && n.props.children==='Reload Pi to enable independent child goals. Assigned goals are read-only here.'));
  };
  assertReadOnly(all);
  reply.snapshot.goal={id:'goal-1',status:'active',text:'Ship safely',automaticTurns:2,tokensUsed:120,tasks:[]};
  all=draw();
  assertReadOnly(all);
  assert.ok(all.some(n=>n.type==='Text' && n.props.children==='Ship safely'));
  reply.snapshot.goal.status='paused';
  reply.snapshot.completedGoals=[{id:'done-1',status:'completed',text:'Earlier goal',summary:'Done',endedAt:1,tasks:[]}];
  all=draw();
  assertReadOnly(all);
  assert.equal(all.filter(n=>n.type==='Pressable' && n.props.accessibilityLabel==='Completed').length,1,'history control is not duplicated');
  findButton(all,'Completed').props.onPress();
  all=draw();
  assertReadOnly(all);
  assert.ok(all.some(n=>n.type==='Text' && n.props.children==='Earlier goal'),'legacy history still expands');
  assert.ok(findButton(all,'Hide completed'));
  assert.equal(calls.some(c=>c.name==='workflows_control'),false,'read-only legacy display never sends mutations');
  slots=[];
  const drawTrees=()=>{cursor=0;return nodes(WorktreesPanel(props));};
  let trees=drawTrees();
  findButton(trees,'Connect current session')?.props.onPress();
  reply.snapshot.worktreeError='Worktree inventory timed out; open a repository directly for a narrower view.';
  trees=drawTrees();
  assert.equal(trees.some(n=>n.type==='Text' && n.props.children===reply.snapshot.worktreeError),false,'requested timeout copy is hidden');
  assert.equal(trees.some(n=>n.type==='Text' && /No .*worktrees|No Git repositories/.test(String(n.props.children))),false,'failed inventory is not rendered as complete empty inventory');
  reply.snapshot.worktreeError='Permission denied reading repository';
  trees=drawTrees();
  assert.ok(trees.some(n=>n.type==='Text' && n.props.children===reply.snapshot.worktreeError),'other inventory errors remain visible');
});

const palettes = [
  { foreground: '#eeeeee', foregroundMuted: '#999999', surface0: '#151619', surface1: '#1d1e22', surface2: '#28292d', border: '#333438', statusDanger: '#ef8888' },
  { foreground: '#202124', foregroundMuted: '#6b6e76', surface0: '#ffffff', surface1: '#f7f7f8', surface2: '#ededf0', border: '#dddddf', statusDanger: '#b73030' },
];

for (const [index, colors] of palettes.entries()) {
  test(`compiled native geometry and theme colors are consistent in palette ${index}`, () => {
    const surface = render(components.Surface, { colors, padded: true, children: 'Body' });
    assert.equal(style(surface.props.style).borderRadius, 8);
    assert.equal(style(surface.props.style).padding, 12);
    assert.equal(style(surface.props.style).backgroundColor, colors.surface1);
    const heading = render(components.SectionHeading, { colors, title: 'Background jobs' });
    const title = nodes(heading).find(n => n.type === 'Text');
    assert.equal(title.props.style.fontSize, 12);
    assert.equal(title.props.style.lineHeight, 18);
    assert.equal(title.props.style.color, colors.foregroundMuted);
    const metadata = render(components.Metadata, { colors, children: 'Running · 17s' });
    assert.equal(style(metadata.props.style).color, colors.foregroundMuted);
  });
}

test('compiled row hover, press, disclosure and selection retain the original action', () => {
  const colors = palettes[0]; let calls = 0;
  const props = { colors, title: 'A long descriptive worker title', detail: 'Waiting for input', expanded: true, onPress: () => calls++ };
  let row = render(components.NativeRow, props);
  assert.equal(row.props.accessibilityRole, 'button');
  assert.equal(row.props.accessibilityState.expanded, true);
  assert.equal(style(row.props.style({ pressed: false })).backgroundColor, 'transparent');
  row.props.onHoverIn();
  row = render(components.NativeRow, props, false);
  assert.equal(style(row.props.style({ pressed: false })).backgroundColor, colors.surface1);
  assert.equal(style(row.props.style({ pressed: true })).backgroundColor, colors.surface2);
  row.props.onPress(); assert.equal(calls, 1);
  const selected = render(components.NativeRow, { ...props, selected: true });
  assert.equal(style(selected.props.style({ pressed: false })).backgroundColor, colors.surface2);
  const disabled = render(components.NativeRow, { ...props, disabled: true });
  assert.equal(disabled.props.disabled, true);
  assert.equal(disabled.props.accessibilityState.disabled, true);
  assert.equal(style(disabled.props.style({ pressed: true })).opacity, 0.5);
});

test('compiled native button keeps danger, disabled and press feedback distinct', () => {
  const colors = palettes[0];
  const button = render(components.NativeButton, { colors, label: 'Stop', onPress() {}, danger: true });
  assert.equal(style(button.props.style({ pressed: true })).backgroundColor, colors.surface2);
  assert.equal(nodes(button).find(n => n.type === 'Text').props.style.color, colors.statusDanger);
  assert.equal(style(button.props.style({ pressed: false })).borderRadius, 8);
});

test('compiled primary action uses host accent tokens and dims only through opacity', () => {
  const colors = {...palettes[0],accent:'#18774e',accentForeground:'#ffffff'};
  const button = render(components.NativeButton,{colors,label:'Create',onPress(){},primary:true,disabled:true});
  assert.equal(style(button.props.style({pressed:false})).backgroundColor,colors.accent);
  assert.equal(style(button.props.style({pressed:false})).opacity,0.5);
  assert.equal(nodes(button).find(n=>n.type==='Text').props.style.color,colors.accentForeground);
});

test('compiled output remains bounded and selectable and copies the exact payload', async () => {
  const text = 'literal JSON {"status":"preserve; punctuation"}\n' + 'output\n'.repeat(100);
  const tree = render(components.OutputWell, { colors: palettes[0], text, monospace: true, platform: 'ios', maxHeight: 240 });
  const all = nodes(tree);
  assert.equal(all.find(n => n.type === 'ScrollView').props.style.maxHeight, 240);
  const body = all.find(n => n.type === 'Text');
  assert.equal(body.props.selectable, true);
  assert.equal(body.props.children, text);
  assert.equal(body.props.style.fontFamily, 'Menlo');
  assert.equal(body.props.style.fontSize, 12);
  assert.equal(body.props.style.lineHeight, 18);
  const copy = all.find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Copy');
  assert.ok(copy);
  copy.props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clipboard.at(-1), text);
});
