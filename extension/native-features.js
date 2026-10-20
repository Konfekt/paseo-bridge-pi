const definitions = [
  { id: "fast_mode", key: "__piFastModeControlV1", label: "Fast mode", icon: "zap", tooltip: "OpenAI priority inference on supported models. May increase cost." },
  { id: "review_edits", key: "__piSlowModeControlV1", label: "Review edits", icon: "shield-check", tooltip: "Review write/edit tool changes before applying them." },
];
export function featureSnapshot(sessionId) {
  return definitions.flatMap(({ key, ...definition }) => {
    try {
      const service = globalThis[key];
      if (service?.version !== 1) return [];
      const state = service.status(sessionId);
      return state?.sessionId === sessionId && state.available === true && typeof state.enabled === "boolean"
        ? [definition.id === "review_edits"
          ? { type: "select", ...definition, desktopTrigger: "label", value: state.enabled ? "on" : "off",
              tooltip: `Review edits: ${state.enabled ? "On" : "Off"}. Applies to write/edit tools.`,
              options: [{ id: "on", label: "Review: On" }, { id: "off", label: "Review: Off" }] }
          : { type: "toggle", ...definition, value: state.enabled }] : [];
    } catch { return []; }
  });
}
export async function handleNativeFeatureRequest(command, context, transport) {
  const ctx = context(), connection = transport();
  if (!ctx || !connection?.connected) throw Error("Native feature control unavailable");
  const sessionId = ctx.sessionManager.getSessionId(), runtimeEpoch = connection.operatorEpoch;
  const current = () => transport() === connection && connection.connected && connection.operatorEpoch === runtimeEpoch && context()?.sessionManager.getSessionId() === sessionId;
  if (command.type === "set_pi_feature") {
    if (command.sessionId !== sessionId || command.runtimeEpoch !== runtimeEpoch || typeof command.value !== "boolean") throw Error("Stale or invalid feature selection");
    const definition = definitions.find(item => item.id === command.featureId);
    const service = definition && globalThis[definition.key];
    if (!definition || service?.version !== 1 || !featureSnapshot(sessionId).some(item => item.id === definition.id)) throw Error("Feature unavailable");
    await service.setEnabled(sessionId, command.value);
    if (!current() || globalThis[definition.key] !== service) throw Error("Feature context changed");
    const state = service.status(sessionId);
    if (state.sessionId !== sessionId || state.enabled !== command.value) throw Error("Feature change could not be verified");
  } else if (command.type !== "get_pi_features") throw Error("Unknown feature command");
  if (!current()) throw Error("Feature context changed");
  return { sessionId, runtimeEpoch, features: featureSnapshot(sessionId) };
}
