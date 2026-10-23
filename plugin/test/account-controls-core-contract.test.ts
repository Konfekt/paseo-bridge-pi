import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const source = process.env.PI_AGENT_EXTENSIONS_SOURCE;

test("bridge mirror covers snapshots from the real core implementation and its current DTO unions", {skip: !source}, async () => {
 const { createAccountControlsSnapshot } = await import(pathToFileURL(resolve(source!, 'openai-accounts/account-controls.ts')).href);
 const owner:any={sessionId:"core-session",signal:new AbortController().signal,selections:{openai:null},results:new Map(),pendingSyncTasks:new Set(),context:{isIdle:()=>true},switchReserved:0,openAIRequestCount:0,selectionRevisions:new Map()};
 const store:any={readAsync:async()=>({providers:{}})};
 const ctx:any={modelRegistry:{getProvider:()=>({getModels:()=>[{id:"gpt"}]}),getProviderAuthStatus:()=>({configured:true}),isUsingOAuth:()=>true}};
 owner.sessionManager={getSessionId:()=>owner.sessionId};
 owner.context={...ctx,isIdle:()=>true,sessionManager:owner.sessionManager};
 const coreSnapshot=await createAccountControlsSnapshot(owner,store,"core-epoch");
 assert.equal(coreSnapshot.usage.effectiveCredential,"chatgpt-grant-configured");
 assert.equal(coreSnapshot.usage.status,"local-binding-confirmed");
 assert.equal(coreSnapshot.usage.remoteEntitlement,"not-queried");
 const mirror=await readFile(new URL("../shared/account-controls.ts",import.meta.url),"utf8");
 for(const value of ["chatgpt-grant-configured","chatgpt-grant-matched-refreshed","local-binding-confirmed","not-queried","invalid-request"]){assert.ok(mirror.includes(value),`bridge DTO mirror missing core contract value ${value}`);}
 assert.equal(typeof coreSnapshot.usage.settingsUrl,"string");
});
