import { treeAttemptKey } from '../shared/subagent-tree.ts';
type Page = { items: any[]; nextCursor?: string; sessionId: string; state: string; hierarchyPartial?: boolean; hierarchyMessage?: string };
class InventoryDeadline extends Error {}
/** Whole inventory budget, including root pagination; React Query owns single-flight. */
export async function readSubagents<T extends Page>(load: (cursor?: string) => Promise<T>, timeoutMs = 3500): Promise<T> {
 const deadline = performance.now() + timeoutMs;
 async function boundedLoad(cursor?: string): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new InventoryDeadline();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([load(cursor), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InventoryDeadline()), remaining); })]); }
  finally { if (timer) clearTimeout(timer); }
 }
 const first = await boundedLoad(), items = [...first.items];
 let cursor = first.nextCursor, hierarchyPartial = first.hierarchyPartial, hierarchyMessage = first.hierarchyMessage;
 const seen = new Set<string>();
 const incomplete = () => {
  hierarchyPartial = true;
  hierarchyMessage = 'Additional agent pages are unavailable within the inventory read budget; this tree is partial. Descendants of exited or unverifiable agents are unavailable; historical ancestry is not inferred.';
 };
 while (cursor) {
  if (seen.has(cursor) || seen.size >= 10 || items.length >= 2000) { incomplete(); break; }
  seen.add(cursor);
  let page: T;
  try { page = await boundedLoad(cursor); }
  catch (error) { if (!(error instanceof InventoryDeadline)) throw error; incomplete(); break; }
  if (page.state !== 'available' || page.sessionId !== first.sessionId) throw new Error('Subagent inventory changed');
  if (items.length + page.items.length > 2000) { incomplete(); break; }
  if (page.hierarchyPartial) { hierarchyPartial = true; hierarchyMessage = page.hierarchyMessage; }
  items.push(...page.items); cursor = page.nextCursor;
 }
 const unique = new Map(items.map(item => [treeAttemptKey(item), item]));
 return { ...first, items: [...unique.values()], nextCursor: undefined, hierarchyPartial, hierarchyMessage };
}
