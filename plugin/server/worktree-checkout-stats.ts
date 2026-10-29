import { realpath, stat } from "node:fs/promises";
import type { WorkflowSnapshot } from "../shared/workflows";

type Counts = { additions: number; deletions: number };
export type CheckoutInspector = (cwd: string) => Promise<{ cwd: string; isGit: boolean; error: unknown; diffStat?: Counts | null }>;
type Entry = { at: number; value: Counts | null; pending?: Promise<void> };
const cache = new Map<string, Entry>();
const TTL = 15_000, MAX_CACHE = 512, CONCURRENCY = 4;
let active = 0;
export function validCounts(value: unknown): value is Counts {
  if (!value || typeof value !== "object") return false;
  const v = value as Counts;
  return Number.isSafeInteger(v.additions) && v.additions >= 0 && Number.isSafeInteger(v.deletions) && v.deletions >= 0;
}
async function identity(path: string) {
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("Checkout is not a directory");
  return { path: canonical, key: `${canonical}:${info.dev}:${info.ino}` };
}
/** Bounded native reads, not workspace creation or local replacement Git semantics.
 * Cached results are session/service/workspace and physical-directory bound. Slow
 * requests retain their concurrency slot until settlement; polls cannot pile up
 * timed-out native work. Later polls pick up completed reads and remaining rows.
 */
export async function inspectWorktreeStats(snapshot: WorkflowSnapshot, workspaceId: string, inspect: CheckoutInspector): Promise<WorkflowSnapshot> {
  const deadline = Date.now() + 1200;
  const scope = `${snapshot.sessionId}:${snapshot.serviceEpoch}:${workspaceId}`;
  const rows = await Promise.all(snapshot.worktrees.map(async tree => {
    if (tree.stale) return { tree, location: null };
    try { return { tree, location: await identity(tree.path) }; }
    catch { return { tree, location: null }; }
  }));
  let started = 0;
  const pending = new Set<Promise<void>>();
  // Service never-seen/oldest rows first, so a large inventory cannot starve.
  const candidates = [...rows].sort((a, b) => (cache.get(`${scope}:${a.location?.key}`)?.at ?? 0) - (cache.get(`${scope}:${b.location?.key}`)?.at ?? 0));
  for (const { tree, location } of candidates) {
    if (!location || Date.now() >= deadline) continue;
    const key = `${scope}:${location.key}`;
    const previous = cache.get(key);
    if (previous?.pending) { pending.add(previous.pending); continue; }
    if (previous && Date.now() - previous.at < TTL) continue;
    if (started >= 32) break;
    if (active >= CONCURRENCY) {
      if (!pending.size) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([...pending, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })]);
      if (timer) clearTimeout(timer);
      if (Date.now() >= deadline || active >= CONCURRENCY) break;
    }
    if (!previous && cache.size >= MAX_CACHE) {
      const expired = [...cache].find(([, value]) => !value.pending);
      if (!expired) continue;
      cache.delete(expired[0]);
    }
    const entry: Entry = { at: 0, value: null };
    cache.set(key, entry); active++; started++;
    entry.pending = Promise.resolve().then(async () => {
      try {
        const response = await inspect(location.path);
        const current = await identity(tree.path);
        const responsePath = await realpath(response.cwd);
        entry.value = current.key === location.key && responsePath === location.path && response.isGit && !response.error && validCounts(response.diffStat) ? response.diffStat : null;
      } catch { entry.value = null; }
      finally { entry.at = Date.now(); if (entry.pending) pending.delete(entry.pending); entry.pending = undefined; active--; }
    });
    pending.add(entry.pending);
  }
  if (pending.size) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(pending), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })]);
    if (timer) clearTimeout(timer);
  }
  return { ...snapshot, worktrees: await Promise.all(rows.map(async ({ tree, location }) => {
    if (!location) return tree;
    const entry = cache.get(`${scope}:${location.key}`);
    if (!entry || entry.pending || Date.now() - entry.at >= TTL) return tree;
    try {
      if ((await identity(tree.path)).key !== location.key) return tree;
      return { ...tree, diffStat: entry.value };
    } catch { return tree; }
  })) };
}
