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
