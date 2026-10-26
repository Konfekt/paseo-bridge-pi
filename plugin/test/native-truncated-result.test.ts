import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolResult, preferredToolResult, literalToolResult } from '../client/native-tool-details.ts';
test('producer text provenance preserves literal envelope-shaped JSON through live and retained selection',()=>{
 const literal='{"content":[{"type":"text","text":"actual file data"}],"isError":true}';
 assert.equal(normalizeToolResult(literalToolResult(literal,'text')),literal);
 assert.equal(normalizeToolResult(preferredToolResult(literal,'old','text','text')),literal);
 assert.equal(normalizeToolResult(preferredToolResult(undefined,literal,undefined,'text')),literal);
 assert.equal(normalizeToolResult(preferredToolResult({truncated:true,preview:'{broken'},literal,undefined,'text')),literal);
});
const code='const logLevel = "λ🚀";\nconst literal = \'{"content":[1,2]}\';\n'.repeat(100);
const preview=Buffer.from(JSON.stringify({content:[{type:'text',text:code}]})).subarray(0,1984).toString('utf8');
test('exact legacy Read preview cut mid-string never exposes escaped partial envelopes or invents missing text',()=>{
 assert.throws(()=>JSON.parse(preview));
 assert.equal(normalizeToolResult({truncated:true,preview}),'[structured tool output truncated; refresh source]');
 const retained=code.slice(0,300)+'\n[truncated]';
 assert.equal(preferredToolResult({truncated:true,preview},retained),retained);
 assert.equal(normalizeToolResult(preferredToolResult({truncated:true,preview},retained)),retained);
});
test('new normalized producer preview renders readable Unicode/newlines and explicit truncation',()=>{
 const result={truncated:true,normalized:true,preview:code.slice(0,300)};
 assert.equal(normalizeToolResult(result),result.preview+'\n[truncated]');
 assert.equal(preferredToolResult(result,'older retained result'),result);
});
test('only fully parseable known legacy envelopes decode; literal terminal JSON remains exact',()=>{
 assert.equal(normalizeToolResult({truncated:true,preview:JSON.stringify({content:[{type:'text',text:'complete λ\nline'}]})}),'complete λ\nline\n[truncated]');
 const literal=JSON.stringify({truncated:true,preview:'literal file data'});
 assert.equal(normalizeToolResult({content:[{type:'text',text:literal}]}),literal);
 assert.equal(normalizeToolResult({truncated:true,preview:'{"content":[1,2]'}),'[structured tool output truncated; refresh source]');
});
