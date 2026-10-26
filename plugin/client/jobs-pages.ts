/** Fetch the complete authorized inventory or fail visibly; never silently truncate. */
export async function readJobs<T extends { items: Array<{ jobId: string }>; nextCursor?: string; sessionId: string; state: string }>(load: (cursor?: string) => Promise<T>): Promise<T> {
  const first = await load(), items = [...first.items], seen = new Set<string>();
  let cursor = first.nextCursor;
  while (cursor) {
    if (seen.has(cursor) || seen.size >= 400) throw new Error("Invalid or excessive jobs pagination");
    seen.add(cursor);
    const page = await load(cursor);
    if (page.state !== "available" || page.sessionId !== first.sessionId) throw new Error("Jobs inventory changed");
    items.push(...page.items);
    if (items.length > 20000) throw new Error("Jobs inventory capacity exceeded");
    cursor = page.nextCursor;
  }
  const unique = new Map(items.map(item => [item.jobId, item]));
  return { ...first, items: [...unique.values()], nextCursor: undefined };
}
