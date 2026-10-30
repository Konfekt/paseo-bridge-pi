import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {cp,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const exactBackgroundStart = {
  input: { action: 'start', command: 'echo fixture', name: 'Fixture job' },
  raw: 'Started fixture job',
  typed: { content: [{ type: 'text', text: 'Started fixture job' }], details: { job_id: 'job-' + '1'.repeat(24), name: 'Fixture job', status: 'running', action: 'start' } },
};

const compiler=process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler,'PASEO_PLUGIN_COMPILER required');
const require=createRequire(resolve(compiler));
const parent={agentId:'parent',workspaceId:'workspace',expectedSessionId:'session',expectedRuntimeEpoch:'e3231c4d-383b-4959-a768-9e343e144870'};
const identity={taskId:'subagent-task-'+'1'.repeat(24),childId:'subagent-child-'+'2'.repeat(24),groupId:'subagent-job-'+'3'.repeat(24),attempt:1,runtimeId:'runtime',lastUpdated:null,stale:false};
const common={protocol:1,state:'available',sessionId:'session',lastUpdated:null,stale:false};

test('bounded producer envelopes preserve transcript text and identity through background and foreground schemas',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'presentation-wire-parity-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const dir of ['client','shared'])await cp(fileURLToPath(new URL(`../${dir}`,import.meta.url)),resolve(root,dir),{recursive:true});
 await writeFile(resolve(root,'index.client.ts'),`export {mergeLiveToolEvents} from './client/native-tool-details';
import {harnessSubagentConversationRpc,harnessSubagentRouteRpc} from './shared/harness-readonly';
import {foregroundTaskResponseSchema} from './shared/foreground-tasks';
export function rpcSchemas(){return {harnessSubagentConversationRpc,harnessSubagentRouteRpc,foregroundTaskResponseSchema};}
export {extractToolPresentation,extractRetainedToolPresentation,extractToolPresentationArguments,validateToolPresentation,validateToolPresentationArguments} from './shared/tool-presentation';
`);
 const {compilePlugin}=await import(pathToFileURL(resolve(compiler)));const {clientBundle}=await compilePlugin({client:resolve(root,'index.client.ts'),server:null});
 const bridge=(0,eval)(clientBundle)(name=>{if(name==='@getpaseo/plugin')return {defineRpc:value=>value};if(name==='zod')return require(name);throw new Error('Unexpected host runtime import '+name)});
 Object.assign(bridge,bridge.rpcSchemas());
 const raw=exactBackgroundStart.raw;
 const meta=bridge.extractToolPresentation('background_job',exactBackgroundStart.typed);
 const response={...common,item:{...identity,truncated:false,messages:[{id:'assistant',role:'assistant',text:'',parts:[{type:'toolCall',id:'call',name:'background_job',arguments:{truncated:true,preview:'old clipped arguments'},toolArguments:bridge.extractToolPresentationArguments('background_job',exactBackgroundStart.input),status:'completed',result:raw,resultFormat:'text',toolPresentation:meta}]},{id:'tool',role:'tool',text:raw,resultFormat:'text',toolCallId:'call',toolName:'background_job',status:'completed',toolPresentation:meta}],liveEvents:[{sequence:1,kind:'tool_start',toolCallId:'live',name:'background_job',status:'running',arguments:{truncated:true,preview:'old live arguments'},toolArguments:bridge.extractToolPresentationArguments('background_job',exactBackgroundStart.input)},{sequence:2,kind:'tool_end',toolCallId:'live',name:'background_job',status:'completed',result:raw,resultFormat:'text',toolPresentation:meta}]}};
 const parsed=bridge.harnessSubagentConversationRpc.output.parse(response);assert.equal(parsed.item.messages[1].text,raw);assert.deepEqual(parsed.item.messages[0].parts[0].toolArguments,exactBackgroundStart.input);assert.deepEqual(parsed.item.liveEvents[1].toolPresentation,parsed.item.messages[1].toolPresentation);
 const mergedLive=bridge.mergeLiveToolEvents(parsed.item.liveEvents);assert.equal(mergedLive.length,1);assert.deepEqual(mergedLive[0].toolArguments,exactBackgroundStart.input,'schema-added undefined end field must not erase safe start arguments');
 const literal='{"content":[{"type":"text","text":"LITERAL JSON MUST STAY"}]}';
 const old=bridge.harnessSubagentConversationRpc.output.parse({...common,item:{...identity,truncated:false,messages:[{id:'old',role:'tool',text:literal,resultFormat:'text',toolName:'custom_tool'}]}});
 assert.equal(old.item.messages[0].text,literal);assert.equal(old.item.messages[0].toolPresentation,undefined);
 for(const bad of [{...meta,version:2},{...meta,toolName:'read'},{...meta,result:{...meta.result,details:{...meta.result.details,capability:'PRIVATE'}}},{...meta,result:{content:[{type:'text',text:'x'.repeat(20000)}]}},JSON.parse('{"version":1,"toolName":"background_job","result":{"__proto__":{"private":"bad"}}}')]){
  const value=bridge.harnessSubagentConversationRpc.output.parse({...common,item:{...identity,truncated:false,messages:[{id:'bad',role:'tool',text:'KEEP FAILURE DIAGNOSTIC',toolName:'background_job',toolPresentation:bad}]}}).item.messages[0];
  assert.equal(value.toolPresentation,undefined);assert.equal(value.text,'KEEP FAILURE DIAGNOSTIC');
 }
 const fgTask={taskId:identity.taskId,childId:identity.childId,groupId:identity.groupId,workerEpoch:'worker',attempt:1,title:'Fixture',status:'running',createdAt:'now',updatedAt:'now',pendingInteractions:0,canPrompt:false,canStop:false};
 const foreground=bridge.foregroundTaskResponseSchema.parse({protocol:1,state:'available',sessionId:'session',epoch:'epoch',view:{task:fgTask,interactions:[],truncated:false,messages:[{id:'fg',role:'tool',text:raw,timestamp:'now',toolName:'background_job',toolCallId:'call',toolPhase:'result',arguments:exactBackgroundStart.input,status:'completed',resultFormat:'text',toolPresentation:meta},{id:'legacy',role:'tool',text:literal,timestamp:'now',toolName:'custom_tool'}]}});
 assert.equal(foreground.view.messages[0].text,raw);assert.deepEqual(foreground.view.messages[0].arguments,exactBackgroundStart.input);assert.equal(foreground.view.messages[1].text,literal);
 const route=bridge.harnessSubagentRouteRpc.input.parse({...parent,taskId:identity.taskId,childId:identity.childId,groupId:identity.groupId,attempt:1,runtimeId:identity.runtimeId});assert.equal(route.expectedSessionId,'session');assert.equal(route.attempt,1);
 assert.throws(()=>bridge.harnessSubagentRouteRpc.input.parse({...route,attempt:0}));assert.throws(()=>bridge.harnessSubagentRouteRpc.input.parse({...route,expectedRuntimeEpoch:'wrong'}));
});
