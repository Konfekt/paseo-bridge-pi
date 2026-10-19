import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { accountControlsSnapshotSchema, accountControlsStatusRpc, accountControlsSwitchRpc } from "../shared/account-controls";
import { callAccountControls, readAccountControlsDescriptor, validateAccountControlsDescriptor } from "./account-controls-transport";

export function createAccountControlsHandlers(readDescriptor = readAccountControlsDescriptor, callControls = callAccountControls) {
 async function validateTarget(input: {agentId:string;workspaceId:string}, context:PluginHandlerContext) {
  const current=await context.paseo.agents.ref(input.agentId).refresh();
  if(!current||current.agent.id!==input.agentId||current.agent.workspaceId!==input.workspaceId||current.agent.provider!=="pi") throw new Error("Account-controls request does not match current Pi agent workspace.");
 }
 async function invoke(input:{agentId:string;workspaceId:string;expectedSessionId:string;expectedRuntimeEpoch:string;request:Record<string,unknown>},context:PluginHandlerContext){
  await validateTarget(input,context); const d=await readDescriptor(input.agentId);
  if(!validateAccountControlsDescriptor(d,input.agentId)||d.sessionId!==input.expectedSessionId||d.runtimeEpoch!==input.expectedRuntimeEpoch) throw new Error("The active Pi session changed. Refresh before switching accounts.");
  const result:any=await callControls(d,{operation:"switch",request:input.request});
  const parsed={...result,snapshot:accountControlsSnapshotSchema.parse(result?.snapshot)};
  if(parsed.requestId!==input.request.requestId||parsed.snapshot.sessionId!==d.sessionId||parsed.snapshot.serviceEpoch!==d.serviceEpoch) throw new Error("Account-controls service identity mismatch.");
  await validateTarget(input,context); const current=await readDescriptor(input.agentId);
  if(!validateAccountControlsDescriptor(current,input.agentId)||current.sessionId!==d.sessionId||current.runtimeEpoch!==d.runtimeEpoch||current.serviceEpoch!==d.serviceEpoch) throw new Error("The active Pi or account-controls service changed during the request.");
  return parsed;
 }
 return {
  status:async(input:RpcInput<typeof accountControlsStatusRpc>,context:PluginHandlerContext)=>{
   await validateTarget(input,context); const d=await readDescriptor(input.agentId);
   if(!validateAccountControlsDescriptor(d,input.agentId)) return {available:false,sessionId:null,runtimeEpoch:null,snapshot:null,reason:"OpenAI account controls are unavailable for this Pi session."};
   try {const snapshot=accountControlsSnapshotSchema.parse(await callControls(d,{operation:"snapshot",sessionId:d.sessionId}));
    await validateTarget(input,context);const cur=await readDescriptor(input.agentId);
    if(!validateAccountControlsDescriptor(cur,input.agentId)||cur.sessionId!==d.sessionId||cur.runtimeEpoch!==d.runtimeEpoch||cur.serviceEpoch!==d.serviceEpoch||snapshot.sessionId!==d.sessionId||snapshot.serviceEpoch!==d.serviceEpoch) throw new Error("Stale account-controls identity");
    return {available:true,sessionId:d.sessionId,runtimeEpoch:d.runtimeEpoch,snapshot,reason:null};
   }catch{return {available:false,sessionId:d.sessionId,runtimeEpoch:d.runtimeEpoch,snapshot:null,reason:"OpenAI account controls are unavailable. Refresh to retry."};}
  },
  switch:(input:RpcInput<typeof accountControlsSwitchRpc>,context:PluginHandlerContext)=>invoke(input,context),
 };
}
