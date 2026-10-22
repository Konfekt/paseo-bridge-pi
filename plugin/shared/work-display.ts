/** Execution-state classification for jobs and foreground work (not agent retention). */
/** Missing retention metadata must never imply that a native agent was reaped. */
export function isActiveAgent(row: { status: string; reaped?: boolean }): boolean {
  return row.reaped !== true && row.status !== "reaped";
}

export function isActiveWorkStatus(status: string): boolean {
  return ["running", "pending", "starting", "launching", "waiting-input", "waiting-permission", "waiting", "blocked", "needs_input"].includes(status);
}
