import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiler = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler, 'PASEO_PLUGIN_COMPILER is required');

test('compiled tool details preserve literal output, redact media, and keep failures within the text budget', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'paseo-tool-details-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['client', 'shared']) {
    await cp(fileURLToPath(new URL(`../${dir}`, import.meta.url)), resolve(root, dir), { recursive: true });
  }
  await writeFile(resolve(root, 'index.client.tsx'), 'export { NativeToolBadge } from "./client/native-transcript";');
  const { compilePlugin } = await import(pathToFileURL(resolve(compiler)));
  const { clientBundle } = await compilePlugin({ client: resolve(root, 'index.client.tsx'), server: null });
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const { NativeToolBadge } = (0, eval)(clientBundle)(name => {
    if (name === 'react') return {};
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable' };
    if (name === '@getpaseo/plugin/client/react-native') return { Icon: 'Icon', ScrollView: 'ScrollView' };
    throw new Error(`Unexpected runtime dependency: ${name}`);
  });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : [value, ...nodes(value.props.children)];
  const colors = { foreground: '#111111', foregroundMuted: '#888888', statusDanger: '#cc0000' };
  const draw = overrides => nodes(NativeToolBadge({ name: 'custom_tool', status: 'completed', colors, expanded: true, onToggle() {}, ...overrides }));
  const bodies = tree => tree.filter(node => node.props.testID === 'work-tool-text');
  const literal = '{"content":[{"type":"text","text":"literal JSON"}]}';
  const output = { content: [{ type: 'text', text: literal }, { type: 'image', mimeType: 'image/png', data: 'BINARY_SECRET' }] };
  const tree = draw({ argumentsValue: 'literal arguments', result: output });
  assert.deepEqual(bodies(tree).map(node => node.props.children), ['literal arguments', `${literal}\n[image: image/png]`]);
  assert.ok(bodies(tree).every(node => node.props.selectable));
  assert.doesNotMatch(JSON.stringify(tree), /BINARY_SECRET/);

  const failed = draw({ status: 'failed', argumentsValue: { message: '😀'.repeat(50000) }, result: 'Permission denied' });
  const result = bodies(failed).find(node => node.props.children === 'Permission denied');
  assert.equal(result?.props.style.color, colors.statusDanger);
  const text = failed.filter(node => node.type === 'Text').map(node => node.props.children).join('');
  assert.ok(Buffer.byteLength(text) <= 24 * 1024 + 'custom_tool'.length);
  assert.match(text, /\[truncated\]/);
  assert.doesNotMatch(text, /\ufffd/);

  const known = draw({ name: 'bash', argumentsValue: { command: 'pwd', private: 'ARGUMENT_SECRET' }, result: 'original text', toolPresentation: { version: 1, toolName: 'read', result: { content: [{ type: 'text', text: 'WRONG_TOOL_RESULT' }] } } });
  assert.match(JSON.stringify(known), /pwd|original text/);
  assert.doesNotMatch(JSON.stringify(known), /ARGUMENT_SECRET|WRONG_TOOL_RESULT/);
  const oversized = draw({ name: 'bash', argumentsValue: { command: 'x'.repeat(17000), private: 'ARGUMENT_SECRET' }, result: 'Command failed' });
  assert.doesNotMatch(JSON.stringify(oversized), /ARGUMENT_SECRET/);
  assert.match(JSON.stringify(oversized), /arguments unavailable/);
  const unknown = draw({ argumentsValue: { query: 'Unknown tool input' } });
  assert.match(JSON.stringify(unknown), /Unknown tool input/);
});
