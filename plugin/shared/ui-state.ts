export type GateUiState = {
  available: boolean;
  enabled: boolean | null;
  pending: boolean;
  fetching: boolean;
  stale: boolean;
  error: boolean;
};

export function gateControlsDisabled(state: GateUiState): boolean {
  return !state.available || state.enabled === null || state.pending || state.fetching || state.stale || state.error;
}

export function gateLabel(state?: Pick<GateUiState, "available" | "enabled">): string {
  if (!state) return "Access · …";
  if (!state.available || state.enabled === null) return "Access unavailable";
  return state.enabled ? "Dangerous ask" : "Full access";
}

export function hasNativeAccessModes(modes?: readonly { id: string }[]): boolean {
  return !!modes?.some(mode => mode.id === "pi-prompts-on")
    && !!modes.some(mode => mode.id === "pi-prompts-off");
}
