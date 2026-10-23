import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountControlsDescriptorPath, removeAccountControlsDescriptor, validateAccountControlsEnvelope, writeAccountControlsDescriptor } from "../extension/account-controls-operator.js";

test("account-control descriptor is private, agent-keyed, epoch-scoped and envelope rejects stale or extra fields",async()=>{
 const root=await mkdtemp(join(tmpdir(),"accounts-"));
 try{
  const d={version:1,socketPath:join(root,"bridge.account-controls"),capability:"a".repeat(64),agentId:"agent",sessionId:"session",runtimeEpoch:"123e4567-e89b-42d3-a456-426614174000",serviceEpoch:"service-1"};
  const path=writeAccountControlsDescriptor(root,d); assert.equal(path,accountControlsDescriptorPath(root,"agent")); assert.equal((await stat(path)).mode&0o777,0o600); assert.deepEqual(JSON.parse(await readFile(path,"utf8")),d);
  const before=await stat(path); writeAccountControlsDescriptor(root,d); const unchanged=await stat(path); assert.equal(unchanged.ino,before.ino); assert.equal(unchanged.mtimeMs,before.mtimeMs);
  writeAccountControlsDescriptor(root,{...d,serviceEpoch:"service-2"}); const changed=await stat(path); assert.notEqual(changed.ino,unchanged.ino); assert.equal(JSON.parse(await readFile(path,"utf8")).serviceEpoch,"service-2");
  writeAccountControlsDescriptor(root,d);
  const identity={...d}; const frame={v:1,type:"account_controls",id:"req-1",capability:d.capability,agentId:d.agentId,sessionId:d.sessionId,runtimeEpoch:d.runtimeEpoch,serviceEpoch:d.serviceEpoch,request:{operation:"switch",request:{protocol:1,requestId:"00000000-0000-4000-8000-000000000001",expectedSessionId:d.sessionId,expectedServiceEpoch:d.serviceEpoch,expectedSelectionRevision:0,accountId:null}}};
  assert.equal(validateAccountControlsEnvelope(frame,identity),true);assert.equal(validateAccountControlsEnvelope({...frame,extra:true},identity),false);assert.equal(validateAccountControlsEnvelope({...frame,serviceEpoch:"old"},identity),false);
  const snapshot={...frame,request:{operation:"snapshot",sessionId:d.sessionId}};
  assert.equal(validateAccountControlsEnvelope(snapshot,identity),true,'legacy snapshots remain OpenAI');
  for(const providerId of ['openai','openai-codex']) assert.equal(validateAccountControlsEnvelope({...snapshot,request:{...snapshot.request,providerId}},identity),true);
  assert.equal(validateAccountControlsEnvelope({...snapshot,request:{...snapshot.request,providerId:'other'}},identity),false);
  assert.equal(validateAccountControlsEnvelope({...snapshot,request:{...snapshot.request,providerId:'openai-codex',extra:true}},identity),false);
  assert.equal(validateAccountControlsEnvelope({...snapshot,request:{...snapshot.request,providerId:'openai-codex',sessionId:'old'}},identity),false);
  const management={...frame,request:{operation:'manage',request:{operation:'rename',sessionId:d.sessionId,providerId:'openai-codex',accountId:'same-name',label:'Work'}}};
  assert.equal(validateAccountControlsEnvelope(management,identity),true);
  for(const change of [{providerId:'other'},{sessionId:'old'},{key:'must-never-be-forwarded'},{operation:'__proto__'},{operation:'toString'}])
    assert.equal(validateAccountControlsEnvelope({...management,request:{operation:'manage',request:{...management.request.request,...change}}},identity),false);
  assert.equal(validateAccountControlsEnvelope({...frame,request:{operation:'manage',request:{operation:'default',sessionId:d.sessionId,accountId:null}}},identity),true);
  assert.equal(validateAccountControlsEnvelope({...frame,request:{operation:'manage',request:{operation:'add',sessionId:d.sessionId,providerId:'openai-codex',method:'oauth',accountName:'work'}}},identity),true);
  assert.equal(validateAccountControlsEnvelope({...frame,request:{operation:'switch',request:{...frame.request.request,providerId:'other'}}},identity),false);
  removeAccountControlsDescriptor(root,"agent","wrong-epoch");assert.equal((await stat(path)).isFile(),true);removeAccountControlsDescriptor(root,"agent",d.runtimeEpoch);await assert.rejects(stat(path));
 }finally{await rm(root,{recursive:true,force:true});}
});
