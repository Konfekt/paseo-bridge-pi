import assert from "node:assert/strict";
import test from "node:test";
import { handleSecurityModeRequest, permissionModeId } from "../extension/security-mode-operator.js";

function fixture() {
  const ctx = { sessionManager: { getSessionId: () => "session-a" } };
  const active = { connected: true, operatorEpoch: "epoch-a" };
  let enabled = true;
  let transport = active;
  let context = ctx;
  let available = true;
  let calls = 0;
  const service = {
    version: 1,
    status(sessionId: string) { calls++; if (sessionId !== "session-a") throw new Error("wrong session"); return { sessionId, enabled }; },
    applyMode(sessionId: string, next: boolean) { calls++; if (sessionId !== "session-a") throw new Error("wrong session"); enabled = next; return { sessionId, enabled }; },
  };
  const dependencies = { context: () => context, transport: () => transport,
    service: () => available ? service : undefined };
  return { dependencies, service, setAvailable: (value: boolean) => { available = value; },
    replaceTransport: () => { transport = { connected: true, operatorEpoch: "epoch-b" }; },
    replaceContext: () => { context = { sessionManager: { getSessionId: () => "session-b" } }; },
    calls: () => calls, enabled: () => enabled };
}

test("status reports actual state without agent descriptor and binds to live session/runtime", () => {
  const f = fixture();
  assert.deepEqual(handleSecurityModeRequest({ id: "1", type: "get_security_mode" }, f.dependencies), {
    success: true, data: { sessionId: "session-a", runtimeEpoch: "epoch-a", modeId: "pi-prompts-on" },
  });
  assert.equal(permissionModeId(false), "pi-prompts-off");
});

test("only an explicit set changes mode, and response is status readback", () => {
  const f = fixture();
  const result = handleSecurityModeRequest({ id: "2", type: "set_security_mode", enabled: false,
    sessionId: "session-a", runtimeEpoch: "epoch-a" }, f.dependencies);
  assert.deepEqual(result, { success: true, data: { sessionId: "session-a", runtimeEpoch: "epoch-a", modeId: "pi-prompts-off" } });
  assert.equal(f.enabled(), false);
  assert.equal(f.calls(), 2);
});

test("unavailable, malformed, and stale requests fail closed without writes", () => {
  const f = fixture();
  f.setAvailable(false);
  assert.equal(handleSecurityModeRequest({ id: "3", type: "get_security_mode" }, f.dependencies).success, false);
  f.setAvailable(true);
  const start = f.calls();
  for (const input of [
    { id: "4", type: "set_security_mode", enabled: false, sessionId: "session-a", runtimeEpoch: "old" },
    { id: "5", type: "set_security_mode", enabled: false, sessionId: "session-b", runtimeEpoch: "epoch-a" },
    { id: "bad id", type: "get_security_mode" },
    { id: "6", type: "get_security_mode", credential: "must-not-pass" },
  ]) assert.equal(handleSecurityModeRequest(input, f.dependencies).success, false);
  assert.equal(f.calls(), start);
  assert.equal(f.enabled(), true);
});

test("invalid status and no-op setter cannot report successful policy changes", () => {
  const f = fixture();
  const noOp = { version: 1, status: f.service.status, applyMode() { return { sessionId: "session-a", enabled: true }; } };
  const deps = { ...f.dependencies, service: () => noOp };
  const result = handleSecurityModeRequest({ id: "8", type: "set_security_mode", enabled: false,
    sessionId: "session-a", runtimeEpoch: "epoch-a" }, deps);
  assert.equal(result.success, false);
  assert.equal(f.enabled(), true);
  const unknown = { version: 1, status: () => ({ sessionId: "session-a", enabled: "yes" }), applyMode() {} };
  assert.equal(handleSecurityModeRequest({ id: "9", type: "get_security_mode" }, { ...f.dependencies, service: () => unknown }).success, false);
});

test("unsupported service versions fail closed", () => {
  const f = fixture();
  assert.equal(handleSecurityModeRequest({ id: "10", type: "get_security_mode" },
    { ...f.dependencies, service: () => ({ ...f.service, version: 2 }) }).success, false);
});

test("runtime/context changes during status read invalidate response", () => {
  const f = fixture();
  const originalService = f.service;
  const deps = { ...f.dependencies, service: () => {
    const value = originalService;
    f.replaceTransport();
    return value;
  } };
  assert.equal(handleSecurityModeRequest({ id: "7", type: "get_security_mode" }, deps).success, false);
});
