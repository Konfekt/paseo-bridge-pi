export interface SessionProjectionApi {
  buildSessionProjection?: (entries: any[], leafId?: string | null) => { entries?: any[]; messages?: any[] };
  buildSessionContext: (entries: any[], leafId?: string | null) => { messages: any[] };
}

/** Build Pi's current model-visible messages and retain their owning session entries. */
export function buildProjectedHistory(
  entries: any[],
  leafId: string | null | undefined,
  api: SessionProjectionApi,
): { messages: any[]; projectedEntries: any[]; hasProjection: boolean } {
  if (typeof api.buildSessionProjection === "function") {
    const projection = api.buildSessionProjection(entries, leafId);
    return { messages: projection.messages ?? [], projectedEntries: projection.entries ?? [], hasProjection: Array.isArray(projection.entries) };
  }
  // Older Pi versions expose only buildSessionContext. Do not reconstruct a
  // projection from raw tree entries: that can resurrect context-edit omissions.
  const context = api.buildSessionContext(entries, leafId);
  return { messages: context.messages ?? [], projectedEntries: [], hasProjection: false };
}

export function projectedUserCaptures(projectedEntries: any[]): Array<{ id: string; parentId: string | null; text: string }> {
  const captures: Array<{ id: string; parentId: string | null; text: string }> = [];
  for (const projected of projectedEntries) {
    const source = projected?.sourceEntry;
    if (source?.type !== "message" || source.message?.role !== "user") continue;
    const projectedMessage = (projected.messages ?? []).find((message: any) => message?.role === "user");
    if (!projectedMessage) continue;
    captures.push({
      id: source.id,
      parentId: source.parentId ?? null,
      text: readTextContent(projectedMessage.content),
    });
  }
  return captures;
}

export function readTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part && part.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n\n");
}
