import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountControlsDescriptorPath, readAccountControlsDescriptor, validateAccountControlsDescriptor } from "../server/account-controls-transport.ts";

test("account-controls descriptor is read from a private owner-only file",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pae-accounts-")),ops=join(root,"operators");
 try{await mkdir(ops,{mode:0o700});await chmod(ops,0o700);const d={version:1,socketPath:"/tmp/account-controls.sock",capability:"b".repeat(64),agentId:"a",sessionId:"s",runtimeEpoch:"123e4567-e89b-42d3-a456-426614174000",serviceEpoch:"service"};
 await writeFile(accountControlsDescriptorPath("a",root),JSON.stringify(d),{mode:0o600});assert.equal(validateAccountControlsDescriptor(await readAccountControlsDescriptor("a",root),"a"),true);
 }finally{await rm(root,{recursive:true,force:true});}
});
