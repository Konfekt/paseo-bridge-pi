import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { inspectWorktreeStats } from "../server/worktree-checkout-stats.ts";

test("native checkout reads provide counts without workspace allocation; cache is scoped and preserves real zero", async () => {
 const root=await mkdtemp(join(tmpdir(),"native-worktree-stats-"));
 try {
  const paths=await Promise.all(Array.from({length:10},async(_,i)=>{const path=join(root,String(i));await mkdir(path);return path;}));
  const snapshot:any={sessionId:randomUUID(),serviceEpoch:randomUUID(),worktrees:paths.map(path=>({path,stale:false}))};
  let calls=0,active=0,peak=0;
  const inspect=async(cwd:string)=>{calls++;active++;peak=Math.max(peak,active);await Promise.resolve();active--;return {cwd,isGit:true,error:null,diffStat:{additions:0,deletions:2}};};
  const result=await inspectWorktreeStats(snapshot,"workspace",inspect);
  assert.equal(calls,10);assert.ok(peak<=4);
  for(const row of result.worktrees) assert.deepEqual(row.diffStat,{additions:0,deletions:2});
  await inspectWorktreeStats(snapshot,"workspace",inspect);assert.equal(calls,10);
  await inspectWorktreeStats({...snapshot,serviceEpoch:randomUUID()},"workspace",inspect);assert.equal(calls,20);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("slow native reads keep their slots across polling and do not block status indefinitely", async()=>{
 const root=await mkdtemp(join(tmpdir(),"slow-worktree-stats-"));
 const release: Array<()=>void>=[];
 try {
  const paths=await Promise.all(Array.from({length:8},async(_,i)=>{const path=join(root,String(i));await mkdir(path);return path;}));
  const snapshot:any={sessionId:randomUUID(),serviceEpoch:randomUUID(),worktrees:paths.map(path=>({path,stale:false}))};
  let calls=0;
  const inspect=(cwd:string)=>{calls++;return new Promise<{cwd:string;isGit:boolean;error:null;diffStat:{additions:number;deletions:number}}>(resolve=>release.push(()=>resolve({cwd,isGit:true,error:null,diffStat:{additions:1,deletions:0}})));};
  const first=await inspectWorktreeStats(snapshot,"workspace",inspect);
  assert.equal(calls,4);assert.ok(first.worktrees.every(row=>row.diffStat===undefined));
  const second=await inspectWorktreeStats(snapshot,"workspace",inspect);
  assert.equal(calls,4);assert.ok(second.worktrees.every(row=>row.diffStat===undefined));
  for(const finish of release)finish();
  const settled=await inspectWorktreeStats({...snapshot,worktrees:snapshot.worktrees.slice(0,4)},"workspace",inspect);
  assert.ok(settled.worktrees.every(row=>row.diffStat?.additions===1));
 }finally{for(const finish of release)finish();await new Promise(resolve=>setImmediate(resolve));await rm(root,{recursive:true,force:true});}
});

test("wrong checkout, native errors, unknown counts and replaced directories never become authoritative counts",async()=>{
 const root=await mkdtemp(join(tmpdir(),"native-worktree-stats-"));
 try {
  const path=join(root,"checkout");await mkdir(path);
  const snapshot=()=>({sessionId:randomUUID(),serviceEpoch:randomUUID(),worktrees:[{path,stale:false}]}) as any;
  for(const response of [
   {cwd:root,isGit:true,error:null,diffStat:{additions:5,deletions:1}},
   {cwd:path,isGit:true,error:{message:"failed"},diffStat:{additions:5,deletions:1}},
   {cwd:path,isGit:true,error:null,diffStat:null},
   {cwd:path,isGit:true,error:null,diffStat:{additions:-1,deletions:1}},
  ]) assert.equal((await inspectWorktreeStats(snapshot(),"workspace",async()=>response)).worktrees[0].diffStat,null);
  const synchronousFailure=await inspectWorktreeStats(snapshot(),"workspace",()=>{throw Error("SDK unavailable");});
  assert.equal(synchronousFailure.worktrees[0].diffStat,null,"synchronous SDK failures release the pending slot");
  const swapped=await inspectWorktreeStats(snapshot(),"workspace",async cwd=>{await rename(path,join(root,"old"));await mkdir(path);return {cwd,isGit:true,error:null,diffStat:{additions:9,deletions:0}};});
  assert.equal(swapped.worktrees[0].diffStat,undefined);
  let called=false;
  const stale=snapshot();stale.worktrees[0].stale=true;
  await inspectWorktreeStats(stale,"workspace",async()=>{called=true;throw Error("must not read stale checkout");});
  assert.equal(called,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
