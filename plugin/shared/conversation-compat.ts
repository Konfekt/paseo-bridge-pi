/** Missing freshness in older conversation DTOs is conservatively retained, never implicitly live. */
export function normalizeConversationStale<T extends Record<string, unknown>>(item: T): T & { stale: boolean } {
  return { ...item, stale: typeof item.stale === "boolean" ? item.stale : true };
}
