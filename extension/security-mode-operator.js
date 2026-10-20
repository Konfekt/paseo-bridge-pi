const MODE_IDS = Object.freeze({ ask: "pi-prompts-on", full: "pi-prompts-off" });

export function permissionModeId(enabled) {
  if (typeof enabled !== "boolean") return null;
  return enabled ? MODE_IDS.ask : MODE_IDS.full;
}

export function handleSecurityModeRequest(command, { context, transport, service }) {
  const fail = (error) => ({ success: false, error });
  if (!command || typeof command !== "object" || Array.isArray(command)
    || (command.type !== "get_security_mode" && command.type !== "set_security_mode")) return fail("Invalid security-mode request");
  const expectedKeys = command.type === "get_security_mode"
    ? ["id", "type"] : ["enabled", "id", "runtimeEpoch", "sessionId", "type"];
  if (Object.keys(command).sort().join(",") !== expectedKeys.sort().join(",")
    || typeof command.id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(command.id)) return fail("Invalid security-mode request");
  const ctx = context();
  const activeTransport = transport();
  const operator = service();
  if (!ctx || !activeTransport?.connected || operator?.version !== 1
    || typeof operator.status !== "function" || typeof operator.applyMode !== "function") {
    return fail("Permission-gate operator unavailable");
  }
  const sessionId = ctx.sessionManager.getSessionId();
  const runtimeEpoch = activeTransport.operatorEpoch;
  if (command.type === "set_security_mode") {
    if (typeof command.enabled !== "boolean" || command.sessionId !== sessionId || command.runtimeEpoch !== runtimeEpoch) {
      return fail("Security-mode identity is stale or invalid");
    }
  }
  try {
    if (command.type === "set_security_mode") operator.applyMode(sessionId, command.enabled);
    const mode = operator.status(sessionId);
    if (mode?.sessionId !== sessionId || typeof mode.enabled !== "boolean"
      || (command.type === "set_security_mode" && mode.enabled !== command.enabled)) {
      throw new Error("Permission-gate status unavailable or mode change did not take effect");
    }
    if (transport() !== activeTransport || !activeTransport.connected || context() !== ctx
      || activeTransport.operatorEpoch !== runtimeEpoch || ctx.sessionManager.getSessionId() !== sessionId
      || service() !== operator) throw new Error("Security-mode identity changed during request");
    return { success: true, data: { sessionId, runtimeEpoch, modeId: permissionModeId(mode.enabled) } };
  } catch (error) {
    return fail(error instanceof Error ? error.message.replace(/[\r\n\x00-\x1f\x7f]+/g, " ").slice(0, 300) : "Security-mode request failed");
  }
}
