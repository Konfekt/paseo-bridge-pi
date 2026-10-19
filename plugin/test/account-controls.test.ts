import assert from "node:assert/strict";
import test from "node:test";
import { validateAccountControlsDescriptor } from "../server/account-controls-transport.ts";

test("account-controls descriptors require exact target, capability, runtime and service identities",()=>{
 const d={version:1,socketPath:"/tmp/account-controls.sock",capability:"a".repeat(64),agentId:"agent",sessionId:"session",runtimeEpoch:"123e4567-e89b-42d3-a456-426614174000",serviceEpoch:"service-1"};
 assert.equal(validateAccountControlsDescriptor(d,"agent"),true);
 assert.equal(validateAccountControlsDescriptor({...d,extra:true},"agent"),false);
 assert.equal(validateAccountControlsDescriptor({...d,serviceEpoch:""},"agent"),false);
 assert.equal(validateAccountControlsDescriptor(d,"other-agent"),false);
});
