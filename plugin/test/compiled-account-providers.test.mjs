import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiler = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler, 'PASEO_PLUGIN_COMPILER is required');
const require = createRequire(resolve(compiler));
const root = await mkdtemp(resolve(tmpdir(), 'account-providers-'));
after(() => rm(root,{recursive:true,force:true}));
const source = fileURLToPath(new URL('../',import.meta.url));
for (const directory of ['server','shared']) await cp(resolve(source,directory),resolve(root,directory),{recursive:true});
await writeFile(resolve(root,'index.server.ts'),'export { createAccountControlsHandlers } from "./server/account-controls";');
const {compilePlugin} = await import(pathToFileURL(resolve(compiler)));
const {serverBundle} = await compilePlugin({server:resolve(root,'index.server.ts')});
const {createAccountControlsHandlers}=(0,eval)(serverBundle)(name=>name==='@getpaseo/plugin'?{defineRpc:value=>value}:require(name));
const runtimeEpoch = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const context = {paseo:{agents:{ref:()=>({refresh:async()=>({agent:{id:'agent',workspaceId:'workspace',provider:'pi'}})})}}};
const target = {agentId:'agent',workspaceId:'workspace'};
const descriptor = {version:1,socketPath:'/tmp/synthetic-account-controls.sock',capability:'a'.repeat(64),agentId:'agent',sessionId:'session',runtimeEpoch,serviceEpoch:'service'};
function snapshot(providerId, modern=true) {
 return {protocol:1,serviceEpoch:'service',selectionRevision:2,sessionId:'session',accounts:[{id:'same-name',label:providerId==='openai-codex'?'Work':'Personal',authKind:'oauth'}],currentAccountId:null,defaultSelected:true,activationStatus:'inactive',busy:false,canSwitch:true,
  ...(modern?{providerId,supportedProviders:['openai','openai-codex']}:{}),
  usage:{effectiveCredential:'chatgpt-grant-configured',status:'local-binding-confirmed',remoteEntitlement:'not-queried',settingsUrl:'https://chatgpt.com/settings/usage'}};
}
function switchInput(providerId) {
 return {...target,expectedSessionId:'session',expectedRuntimeEpoch:runtimeEpoch,request:{protocol:1,requestId:'11111111-1111-4111-a111-111111111111',expectedSessionId:'session',expectedServiceEpoch:'service',expectedSelectionRevision:2,accountId:'same-name',...(providerId?{providerId}:{})}};
}
test('server rejects substituted chat or workspace before any account transport call',async()=>{
 let calls=0;
 const handlers=createAccountControlsHandlers(async()=>{calls++;return {...descriptor};},async()=>{calls++;throw new Error('must not call');});
 for(const input of [{...switchInput('openai-codex'),agentId:'sibling'},{...switchInput('openai-codex'),workspaceId:'other'}]) await assert.rejects(handlers.switch(input,context),/does not match/);
 assert.equal(calls,0);
});
test('clear inheritance intent is forwarded distinctly from explicit default login',async()=>{
 const calls=[];
 const value={...snapshot('openai-codex'),inheritance:'explicit'};
 const handlers=createAccountControlsHandlers(async()=>({...descriptor}),async(_d,request)=>{calls.push(request);return request.operation==='snapshot'?value:{ok:true,requestId:request.request.requestId,snapshot:value};});
 const input=switchInput('openai-codex'); input.request.accountId=null; input.request.inherit=true;
 assert.equal((await handlers.switch(input,context)).snapshot.inheritance,'explicit');
 assert.equal(calls.at(-1).request.inherit,true);assert.equal(calls.at(-1).request.accountId,null);
});
test('legacy omitted-provider status and switch remain OpenAI-only',async()=>{
 const calls=[];
 const handlers=createAccountControlsHandlers(async()=>({...descriptor}),async(_d,request)=>{
  calls.push(request);
  if(request.operation==='snapshot') return snapshot('openai',false);
  return {ok:true,requestId:request.request.requestId,snapshot:snapshot('openai',false)};
 });
 assert.equal((await handlers.status(target,context)).available,true);
 assert.deepEqual(calls[0],{operation:'snapshot',sessionId:'session'});
 assert.equal((await handlers.switch(switchInput(),context)).ok,true);
 assert.equal(calls.at(-1).request.providerId,undefined);
});
test('private routing capabilities never change the public strict client snapshot shape',async()=>{
 const value={...snapshot('openai'),sessionRouting:{version:1,providerId:'openai-codex',revision:7}};
 const handlers=createAccountControlsHandlers(async()=>({...descriptor}),async(_d,request)=>request.operation==='snapshot'?value:{ok:true,requestId:request.request.requestId,snapshot:value});
 const status=await handlers.status(target,context);
 assert.equal(status.available,true);
 assert.equal('sessionRouting' in status.snapshot,false);
 assert.equal('sessionRouting' in (await handlers.switch(switchInput(),context)).snapshot,false);
 assert.deepEqual(status.snapshot,snapshot('openai'));
});
test('older producer cannot mutate OpenAI when Codex is requested',async()=>{
 const calls=[];
 const handlers=createAccountControlsHandlers(async()=>({...descriptor}),async(_d,request)=>{calls.push(request);return snapshot('openai',false);});
 const status=await handlers.status({...target,providerId:'openai-codex'},context);
 assert.equal(status.available,false);
 await assert.rejects(handlers.switch(switchInput('openai-codex'),context),/does not support/);
 assert.ok(calls.every(call=>call.operation==='snapshot'),'preflight must reject before ANY mutation');
});
test('modern same-name Codex profile is routed with explicit provider and preflight',async()=>{
 const calls=[];
 const handlers=createAccountControlsHandlers(async()=>({...descriptor}),async(_d,request)=>{
  calls.push(request);
  if(request.operation==='snapshot') return snapshot(request.providerId??'openai');
  return {ok:true,requestId:request.request.requestId,snapshot:snapshot(request.request.providerId)};
 });
 const status=await handlers.status({...target,providerId:'openai-codex'},context);
 assert.equal(status.snapshot.providerId,'openai-codex');
 assert.equal(status.snapshot.accounts[0].label,'Work');
 calls.length=0;
 const result=await handlers.switch(switchInput('openai-codex'),context);
 assert.equal(result.snapshot.providerId,'openai-codex');
 assert.deepEqual(calls.map(call=>call.operation),['snapshot','switch']);
 assert.equal(calls[1].request.providerId,'openai-codex');
 assert.equal(calls[1].request.accountId,'same-name');
});
test('service replacement during provider preflight prevents the mutation',async()=>{
 let replaced=false; const calls=[];
 const handlers=createAccountControlsHandlers(async()=>({...descriptor,...(replaced?{serviceEpoch:'replacement'}:{})}),async(_d,request)=>{
  calls.push(request); replaced=true; return snapshot('openai-codex');
 });
 await assert.rejects(handlers.switch(switchInput('openai-codex'),context),/service changed/);
 assert.equal(calls.length,1); assert.equal(calls[0].operation,'snapshot');
});
test('provider mismatch or missing Codex capability fails before mutation',async()=>{
 for(const response of [snapshot('openai'),{...snapshot('openai-codex'),supportedProviders:['openai']}]) {
  const calls=[];
  const handlers=createAccountControlsHandlers(async()=>({...descriptor}),async(_d,request)=>{calls.push(request);return response;});
  await assert.rejects(handlers.switch(switchInput('openai-codex'),context),/does not support/);
  assert.ok(calls.every(call=>call.operation==='snapshot'));
 }
});
