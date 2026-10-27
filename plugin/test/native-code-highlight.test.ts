import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiler = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler, 'PASEO_PLUGIN_COMPILER is required');
const require = createRequire(resolve(compiler));
const root = await mkdtemp(resolve(tmpdir(), 'paseo-native-code-highlight-'));
after(() => rm(root, { recursive: true, force: true }));
await mkdir(resolve(root, 'client'));
await cp(new URL('../client/native-code-model.ts', import.meta.url), resolve(root, 'client/native-code-model.ts'));
await cp(new URL('../client/native-code-highlight.ts', import.meta.url), resolve(root, 'client/native-code-highlight.ts'));
await writeFile(
  resolve(root, 'index.client.ts'),
  `export { nativeCodeRows } from "./client/native-code-model";
export { highlightNativeRows, nativeSyntaxPalette } from "./client/native-code-highlight";
export { highlightToKeyedLines } from "@getpaseo/highlight";`,
);
const { compilePlugin } = await import(pathToFileURL(resolve(compiler)));
const { clientBundle } = await compilePlugin({ client: resolve(root, 'index.client.ts'), server: null });
assert.ok(clientBundle, 'compiler must return the client bundle');
const externalModules = [];
const load = name => {
  externalModules.push(name);
  return require(name);
};
const { nativeCodeRows, highlightNativeRows, nativeSyntaxPalette, highlightToKeyedLines } =
  (0, eval)(clientBundle)(load);

test('Read/Write use canonical tokens and preserve multiline code and literal JSON', () => {
  const text = 'export const value = `hello\nworld`;\nconst literal = \'{"content":[1,2]}\';';
  const rows = highlightNativeRows(nativeCodeRows(text, { startLine: 7 }), text, '/owned/example.ts');
  assert.deepEqual(
    rows.map(row => row.tokens),
    highlightToKeyedLines(text, 'ts')?.map(line => line.tokens.map(({ token }) => token)),
  );
  assert.equal(rows.map(row => row.tokens.map(token => token.text).join('')).join('\n'), text);
  assert.equal(rows[0].number, 7);
  assert.ok(rows.flatMap(row => row.tokens).some(token => token.style === 'keyword'));
});

test('pathless and oversized content remains plain text', () => {
  for (const [text, filePath] of [['echo "literal"', undefined], ['x'.repeat(100001), 'file.ts']]) {
    const rows = highlightNativeRows(nativeCodeRows(text), text, filePath);
    assert.ok(rows.every(row => !row.tokens));
  }
});

test('Edit uses shared old/new document reconstruction and preserves diff prefixes', () => {
  const text = '@@ -1 +1 @@\n-const old = 1;\n+const next = "value";';
  const rows = highlightNativeRows(nativeCodeRows(text, { unifiedDiff: true }), text, 'file.ts', true);
  assert.ok(rows[1].tokens.some(token => token.style === 'keyword'));
  assert.equal(rows[1].tokens.map(token => token.text).join(''), '-const old = 1;');
  assert.equal(rows[2].tokens.map(token => token.text).join(''), '+const next = "value";');
});

test('native default light/dark palettes are shared colors and custom palette wins', () => {
  assert.notEqual(nativeSyntaxPalette({ surface0: '#ffffff' }).keyword, nativeSyntaxPalette({ surface0: '#111111' }).keyword);
  const palette = { keyword: '#123456' };
  assert.equal(nativeSyntaxPalette({ syntax: palette }), palette);
});

test('highlight helpers are bundled rather than requested from the host at runtime', () => {
  assert.deepEqual(externalModules, []);
});
