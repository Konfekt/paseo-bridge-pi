import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readPrivateChildRuntimes } from '../server/child-runtime-registry.ts';
import { ReadBudget, readDescendants } from '../server/subagent-descendants.ts';
const epoch = '00000000-0000-4000-8000-000000000001';
const source = { agentId: 'root', workspaceId: 'workspace', sessionId: 'root-session', runtimeEpoch: epoch };
const task = (id: string) => ({taskId:id,childId:`child-${id}`,groupId:`group-${id}`,runtimeId:`runtime-${id}`,attempt:1,status:'running',stale:false});
const parent = task('parent'), child = task('child');
const record = (row: any, owner: string, agentId: string) => ({...row,managed:true,lifecycle:'active',parentSessionId:owner,agentId,workspaceId:'workspace',pid:1,processStartToken:'live'});
const initial = [record(parent,'root-session','a'),record(child,'a-session','b')];
const page = {state:'available',sessionId:'root-session',stale:false,items:[parent]};
function setup() {
 let registryReads = 0, reads = 0;
 const deps = {
  descriptor: async (agentId: string) => ({version:1,agentId,sessionId:`${agentId}-session`,runtimeEpoch:epoch,capability:'a'.repeat(64),socketPath:'/private.sock'}),
  read: async (owner: any) => { reads++; return {state:'available',sessionId:owner.sessionId,stale:false,items:owner.agentId==='a'?[child]:[]}; },
  verify: async () => {}, records: async () => {registryReads++; return initial;}, token: () => 'live',
 };
 return {deps, counts:()=>({registryReads,reads})};
}
test('expired registry snapshot budget stops before starting filesystem traversal',async()=>{
 await assert.rejects(readPrivateChildRuntimes(()=>{throw new Error('expired snapshot');}),/expired snapshot/);
});
test('healthy tree keeps verified descendants and reuses initial plus one after-read registry snapshot', async()=>{
 const {deps,counts}=setup();
 const result=await readDescendants(page,source,initial,deps);
 assert.deepEqual(result.items.map((r:any)=>r.taskId),['parent','child']);
 assert.equal(result.hierarchyPartial,false);
 assert.equal(counts().registryReads,1);
 assert.equal(counts().reads,2);
 assert.equal(result.hierarchyMessage,undefined, 'healthy complete trees do not show an unavailable warning');
});
test('slow endpoint deadline returns bounded direct inventory and honest partial explanation', async()=>{
 const {deps}=setup(); deps.read=async()=>new Promise(()=>{});
 const start=performance.now();
 const result=await readDescendants(page,source,initial,deps,new ReadBudget(25,12));
 assert.ok(performance.now()-start<250);
 assert.deepEqual(result.items.map((r:any)=>r.taskId),['parent']);
 assert.equal(result.hierarchyPartial,true);assert.match(result.hierarchyMessage,/unavailable|budget/);
});
test('slow after-read verification is bounded and strips unchecked route hints',async()=>{
 const {deps}=setup();deps.records=async()=>new Promise(()=>{});
 const started=performance.now();
 const result=await readDescendants({...page,items:[{...parent,paseoAgentId:'must-remove'}]},source,initial,deps);
 assert.ok(performance.now()-started<700);
 assert.equal(result.items.length,1);assert.equal(result.items[0].paseoAgentId,undefined);
 assert.equal(result.hierarchyPartial,true);assert.match(result.hierarchyMessage,/verification exceeded its read budget/);
});
test('request exhaustion preserves direct and already verified rows with partial explanation',async()=>{
 const {deps,counts}=setup();const result=await readDescendants(page,source,initial,deps,new ReadBudget(100,1));
 assert.equal(counts().reads,1);assert.equal(result.items[0].taskId,'parent');assert.equal(result.hierarchyPartial,true);
});
test('stale after-read ownership removes subtree with explanation, never guesses historical links',async()=>{
 const {deps}=setup();deps.records=async()=>initial.map(r=>({...r,processStartToken:'stale'}));
 const result=await readDescendants(page,source,initial,deps);
 assert.deepEqual(result.items.map((r:any)=>r.taskId),['parent']);assert.equal(result.hierarchyPartial,true);assert.match(result.hierarchyMessage,/stale evidence/);
});
test('stale source epoch drops subtree even with live process ownership',async()=>{
 const {deps}=setup();deps.verify=async()=>{throw new Error('epoch changed');};
 const result=await readDescendants(page,source,initial,deps);
 assert.equal(result.items.length,1);assert.equal(result.hierarchyPartial,true);
});
test('cycle and missing/reaped ownership are explicitly partial and bounded',async()=>{
 const {deps,counts}=setup();const cycle=[initial[0],record(child,'a-session','root')];
 deps.records=async()=>cycle;
 const result=await readDescendants(page,source,cycle,deps);
 assert.equal(counts().reads,1);assert.equal(result.hierarchyPartial,true);
 const missing=await readDescendants(page,source,[],deps);
 assert.equal(missing.items.length,1);assert.equal(missing.hierarchyPartial,true);assert.match(missing.hierarchyMessage,/historical ancestry is not inferred/);
});
