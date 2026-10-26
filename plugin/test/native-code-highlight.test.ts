import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { nativeCodeRows } from '../client/native-code-model.ts';
import { highlightNativeRows, nativeSyntaxPalette } from '../client/native-code-highlight.ts';
import { highlightCode } from '../client/vendor/paseo-highlight/index.js';
test('vendored artifact is the provenance-pinned upstream implementation with dependency licenses',()=>{
 const root=new URL('../client/vendor/paseo-highlight/',import.meta.url),p=JSON.parse(readFileSync(new URL('provenance.json',root),'utf8'));
 assert.equal(p.revision,'cafe4b01c8522ff39560241c5deb01427dc8dc5b');
 assert.equal(createHash('sha256').update(readFileSync(new URL('index.js',root))).digest('hex'),p.bundleSha256);
 assert.ok(p.dependencies.some((d:any)=>d.name==='@lezer/javascript'));
 for(const dependency of p.dependencies) assert.ok(readFileSync(new URL(dependency.licenseFile,root),'utf8').length>100);
});
test('Read/Write use exact upstream tokens and preserve multiline code and literal JSON',()=>{
 const text='export const value = `hello\nworld`;\nconst literal = \'{"content":[1,2]}\';';
 const rows=highlightNativeRows(nativeCodeRows(text,{startLine:7}),text,'/owned/example.ts');
 assert.deepEqual(rows.map(row=>row.tokens),highlightCode(text,'example.ts'));
 assert.equal(rows.map(row=>row.tokens!.map(token=>token.text).join('')).join('\n'),text);
 assert.equal(rows[0].number,7);assert.ok(rows.flatMap(row=>row.tokens!).some(token=>token.style==='keyword'));
});
test('native unsupported/oversized fallback is plain and shell/unknown never infer grammar from output',()=>{
 for(const [text,path] of [['echo "literal"',undefined],['x'.repeat(100001),'file.ts']] as const){
  const rows=highlightNativeRows(nativeCodeRows(text),text,path);assert.ok(rows.every(row=>!row.tokens));
 }
});
test('Edit uses upstream old/new document reconstruction and preserves diff prefixes',()=>{
 const text='@@ -1 +1 @@\n-const old = 1;\n+const next = "value";';
 const rows=highlightNativeRows(nativeCodeRows(text,{unifiedDiff:true}),text,'file.ts',true);
 assert.ok(rows[1].tokens!.some(token=>token.style==='keyword'));
 assert.equal(rows[1].tokens!.map(token=>token.text).join(''),'-const old = 1;');
 assert.equal(rows[2].tokens!.map(token=>token.text).join(''),'+const next = "value";');
});
test('native default light/dark palettes are upstream colors, not a custom highlighter theme',()=>{
 assert.notEqual(nativeSyntaxPalette({surface0:'#ffffff'}).keyword,nativeSyntaxPalette({surface0:'#111111'}).keyword);
 const palette={keyword:'#123456'};assert.equal(nativeSyntaxPalette({syntax:palette}),palette);
});
