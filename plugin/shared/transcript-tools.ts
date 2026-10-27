/** Bridge data-flow helpers only. Native code owns tool classification and text.
 * These helpers never infer identity, arguments or success from displayed prose. */
export type TranscriptToolStatus = "running" | "completed" | "failed" | "unknown" | "canceled" | "cancelled";
type ForegroundEntry = { role: string; toolName?: string; toolCallId?: string; toolPhase?: "call" | "result"; arguments?: unknown };
/** Collapse only one unambiguous same-id/same-name call + result whose
 * arguments are explicitly producer-bound. Legacy/unknown call text otherwise
 * stays visible; duplicate/missing IDs and titles never establish a binding. */
export function foregroundTranscriptMessages<T extends ForegroundEntry>(messages: readonly T[]): T[] {
  const calls = new Map<string, number>(), results = new Map<string, number>();
  const boundResults = new Set<string>();
  const key = (entry: T) => entry.role === "tool" && entry.toolCallId && entry.toolName
    ? JSON.stringify([entry.toolCallId, entry.toolName]) : undefined;
  for (const entry of messages) {
    const id = key(entry);
    if (!id) continue;
    const counts = entry.toolPhase === "call" ? calls : entry.toolPhase === "result" ? results : undefined;
    if (counts) counts.set(id, (counts.get(id) ?? 0) + 1);
    if (entry.toolPhase === "result" && entry.arguments !== undefined) boundResults.add(id);
  }
  return messages.filter(entry => {
    const id = key(entry);
    return entry.toolPhase !== "call" || !id || calls.get(id) !== 1 || results.get(id) !== 1 || !boundResults.has(id);
  });
}
