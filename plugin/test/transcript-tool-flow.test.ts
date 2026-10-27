import assert from 'node:assert/strict';
import test from 'node:test';
import { foregroundTranscriptMessages } from '../shared/transcript-tools.ts';
import { mergeLiveToolEvents, preferredToolPresentation, preferredToolResult } from '../client/native-tool-details.ts';

test('live/history text and typed metadata are always selected from the same result',()=>{
  const old={version:1,toolName:'background_job',result:{details:{status:'completed'}}};
  const fresh={version:1,toolName:'background_job',result:{details:{status:'running'}}};
  assert.equal(preferredToolPresentation('new live text','old retained text',undefined,old),undefined,'new text must not inherit old lifecycle data');
  assert.equal(preferredToolPresentation('new live text','old retained text',fresh,old),fresh);
  assert.equal(preferredToolPresentation(undefined,'old retained text',undefined,old),old);
  assert.equal(preferredToolPresentation('', 'old retained text',undefined,old),undefined,'empty new result is still authoritative');
  const truncated={truncated:true,preview:'partial wire carrier'};
  assert.equal(preferredToolResult(truncated,'retained text','text','text')?.content[0].text,'retained text');
  assert.equal(preferredToolPresentation(truncated,'retained text',fresh,old),old);
});

test('matching live end keeps start arguments and safe projection but uses end presentation',()=>{
  const result=mergeLiveToolEvents([
    {toolCallId:'call',arguments:{path:'/visible'},toolArguments:{path:'/visible'},kind:'tool_start'},
    {toolCallId:'other',arguments:{command:'other'},kind:'tool_start'},
    {toolCallId:'call',kind:'tool_end',toolArguments:undefined,result:'done',toolPresentation:{version:1,toolName:'read',result:{content:[{type:'text',text:'done'}]}}},
  ]);
  assert.deepEqual(result[0].arguments,{path:'/visible'});
  assert.deepEqual(result[0].toolArguments,{path:'/visible'});
  assert.equal(result[0].result,'done');
  assert.equal(result[0].toolPresentation?.toolName,'read');
  assert.equal(result[1].result,undefined);
  const restarted=mergeLiveToolEvents([{toolCallId:'reused',name:'read',kind:'tool_end',result:'old'},{toolCallId:'reused',name:'read',kind:'tool_start',arguments:{path:'fresh'}}]);
  assert.equal(restarted[0].result,undefined,'a new authoritative start cannot retain old completion data');
});

test('foreground history collapses only exact unambiguous call/result identity',()=>{
  const call={role:'tool',toolName:'read',toolCallId:'call',toolPhase:'call' as const,text:'original argument text'};
  const result={role:'tool',toolName:'read',toolCallId:'call',toolPhase:'result' as const,text:'original result text',arguments:{path:'/visible'}};
  assert.deepEqual(foregroundTranscriptMessages([call,result]),[result]);
  assert.equal(call.text,'original argument text');assert.equal(result.text,'original result text');
  assert.deepEqual(foregroundTranscriptMessages([call,{...result,toolName:'write'}]),[call,{...result,toolName:'write'}]);
  assert.equal(foregroundTranscriptMessages([call,{...call},result]).length,3,'ambiguous duplicate IDs remain visible');
  assert.equal(foregroundTranscriptMessages([call,result,{...result}]).length,3,'ambiguous result IDs remain visible');
  assert.equal(foregroundTranscriptMessages([call,{...result,arguments:undefined}]).length,2,'opaque legacy/unknown argument text is not discarded');
  const legacy={role:'tool',toolName:'read',text:'{"content":[{"type":"text","text":"literal JSON"}]}'};
  assert.deepEqual(foregroundTranscriptMessages([legacy]),[legacy],'old snapshots are not parsed or reclassified from text');
});
