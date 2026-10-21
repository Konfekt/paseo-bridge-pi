/** Waiting work remains active; finished and retained records belong in history. */
export function isActiveWorkStatus(status: string): boolean {
  return ["running", "pending", "starting", "launching", "waiting-input", "waiting-permission", "waiting", "blocked", "needs_input"].includes(status);
}
