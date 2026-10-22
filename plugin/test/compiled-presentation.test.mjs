import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath, 'PASEO_PLUGIN_COMPILER is required; native presentation tests must execute');
const require = createRequire(resolve(compilerPath));
const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
const { clientBundle } = await compilePlugin({ client: fileURLToPath(new URL('../client/presentation.tsx', import.meta.url)) });
const jsx = (type, props) => ({ type, props: props ?? {} });
let slots = [], cursor = 0;
const load = name => {
  if (name === 'react') return { useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; } };
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable' };
  if (name === '@getpaseo/plugin/client/react-native') return { ScrollView: 'ScrollView' };
  return require(name);
};
const components = (0, eval)(clientBundle)(load);
const render = (Component, props, reset = true) => { if (reset) slots = []; cursor = 0; return Component(props); };
const style = value => Object.assign({}, ...[value].flat(Infinity).filter(Boolean));
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : typeof value.type === 'function' ? nodes(value.type(value.props)) : [value, ...nodes(value.props.children)];
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

test('compiled output remains bounded and selectable without altering payload text', () => {
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
});
