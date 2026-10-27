import test from 'node:test';
import assert from 'node:assert/strict';
import { readSubagents } from '../client/subagent-pages.ts';
const row=(taskId:string)=>({taskId,childId:`child-${taskId}`,attempt:1,runtimeId:`runtime-${taskId}`});
const first={state:'available',sessionId:'session',items:[row('direct')],nextCursor:'next'};
test('whole inventory deadline preserves loaded rows with visible partial explanation',async()=>{
 const started=performance.now();
 const result=await readSubagents(async cursor=>cursor?new Promise(()=>{}):first,25);
 assert.ok(performance.now()-started<250);
 assert.deepEqual(result.items,first.items);assert.equal(result.hierarchyPartial,true);
 assert.match(result.hierarchyMessage!,/Additional agent pages.*partial/);
});
test('healthy pages preserve later partial metadata and exact attempt identities',async()=>{
 const result=await readSubagents(async cursor=>cursor?{...first,items:[row('child')],nextCursor:undefined,hierarchyPartial:true,hierarchyMessage:'Stale child omitted'}:first);
 assert.equal(result.items.length,2);assert.equal(result.hierarchyPartial,true);assert.equal(result.hierarchyMessage,'Stale child omitted');
});
test('cycle limits are partial, changed ownership is not accepted as a partial snapshot',async()=>{
 const result=await readSubagents(async()=>first);
 assert.equal(result.items.length,1);assert.equal(result.hierarchyPartial,true);
 await assert.rejects(readSubagents(async cursor=>cursor?{...first,sessionId:'changed'}:first),/inventory changed/);
});
