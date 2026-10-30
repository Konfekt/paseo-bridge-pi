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
