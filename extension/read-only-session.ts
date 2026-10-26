/** Retained messages are bounded to512KiB upstream; allow bounded live metadata
 * and envelope overhead without exceeding the768KiB socket response budget. */
export const MAX_READ_ONLY_CONVERSATION_BYTES = 640 * 1024;
export function assertReadOnlyConversationResponse(result: any, sessionId: string): void {
  if (result?.sessionId !== sessionId) throw new Error("Conversation response owner session mismatch");
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_READ_ONLY_CONVERSATION_BYTES) throw new Error("Conversation response exceeds640KiB read budget");
}

/** Pi allocates a fresh ExtensionContext for ordinary events. Context object
 * identity is not owner identity. A lifecycle token additionally rejects an
 * away-and-back session transition, even when the public session ID is reused.
 */
export function sameReadOnlySession(
  capturedLifecycle: object, currentLifecycle: object,
  expectedSessionId: string, currentContext: { sessionManager: { getSessionId(): string } } | null,
): boolean {
  return capturedLifecycle === currentLifecycle && currentContext !== null
    && currentContext.sessionManager.getSessionId() === expectedSessionId;
}
