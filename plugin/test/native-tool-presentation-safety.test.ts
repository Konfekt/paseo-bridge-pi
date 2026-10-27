import assert from 'node:assert/strict';
import test from 'node:test';
import { toolPresentationValue, toolDetailTextBudget, TOOL_DETAIL_BYTES } from '../client/native-tool-details.ts';

test('canonical input preparation preserves literal strings and recognized transport metadata', () => {
  const literal = '{"content":[{"type":"text","text":"literal file JSON"}]}';
  assert.equal(toolPresentationValue(literal), literal);
  assert.deepEqual(toolPresentationValue({ content: [{ type: 'text', text: literal }], details: { presentation: { version: 1, objective: 'Readable' } } }, true), {
    content: [{ type: 'text', text: literal }], details: { presentation: { version: 1, objective: 'Readable' } },
  });
  const quoted = JSON.stringify(literal);
  assert.equal(toolPresentationValue(quoted), quoted, 'arguments never peel wire quoting');
});

test('canonical transport preparation redacts malformed/media siblings across nested wire carriers', () => {
  const envelope = { isError: true, content: [null, { data: 'UNSUPPORTED_SECRET' }, { type: 'image', mimeType: 'image/png', data: 'BINARY_SECRET' }, { type: 'audio', mimeType: 'audio/wav', data: 'AUDIO_SECRET' }, { type: 'text', text: 'Useful failure' }] };
  const encodings = [
    (value: unknown) => value,
    (value: unknown) => JSON.stringify(value),
    (value: unknown) => JSON.stringify(JSON.stringify(value)),
    (value: unknown) => ({ type: 'tool_result', content: JSON.stringify(value) }),
    (value: unknown) => ({ content: [{ type: 'tool_result', content: value }] }),
  ];
  for (const encode of encodings) {
    const result = JSON.stringify(toolPresentationValue(encode(envelope), true));
    assert.doesNotMatch(result, /SECRET/);
    assert.match(result, /Useful failure/);
    assert.match(result, /image/);
    assert.match(result, /audio/);
    assert.match(result, /isError|tool error/, 'typed error flag or legacy error text is preserved');
  }
  let deep: unknown = envelope;
  for (let i = 0; i < 10; i++) deep = JSON.stringify(deep);
  assert.doesNotMatch(JSON.stringify(toolPresentationValue(deep, true)), /SECRET/);
});

test('legacy result carriers decode only in output positions, never argument or terminal text positions',()=>{
  const literal='{"content":[{"type":"text","text":"legacy inner"}]}';
  const carrier={type:'tool_result',content:literal};
  assert.deepEqual(toolPresentationValue(carrier),carrier,'argument objects are not result transports');
  assert.deepEqual(toolPresentationValue(carrier,true),{content:[{type:'text',text:'legacy inner'}]});
  assert.deepEqual(toolPresentationValue({content:[carrier]},true),{content:[{type:'text',text:'legacy inner'}]});
  const clippedArguments={truncated:true,preview:'{"path":"partial'};
  assert.deepEqual(toolPresentationValue(clippedArguments),clippedArguments,'argument previews are never reconstructed as tool output');
});

test('canonical preparation and final text projection are bounded without splitting code points', () => {
  const budget = toolDetailTextBudget();
  const parts = [budget('😀'.repeat(TOOL_DETAIL_BYTES)), budget('more')];
  assert.ok(Buffer.byteLength(parts.join('')) <= TOOL_DETAIL_BYTES);
  assert.match(parts[0], /\[truncated\]$/);
  assert.doesNotMatch(parts.join(''), /\ufffd/);
  const large = toolPresentationValue({ message: '😀'.repeat(50000), rest: 'extra' });
  assert.match(JSON.stringify(large), /truncated/);
  const blocks = toolPresentationValue({ content: Array.from({ length: 200 }, () => ({ type: 'text', text: 'line' })) }, true);
  assert.match(JSON.stringify(blocks), /truncated/);
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  assert.match(JSON.stringify(toolPresentationValue(cycle)), /circular/);
});
