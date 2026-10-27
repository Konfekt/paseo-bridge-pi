import { performance } from 'node:perf_hooks';
import { correlateChildRoutes, resolveExactChildRuntime } from '../shared/existing-child-identity.ts';
import { taskGroupKey, treeAttemptKey, type TaskSource } from '../shared/subagent-tree.ts';
import { validateHarnessReadOnlyDescriptor } from './harness-readonly-transport.ts';

export class ReadBudget {
 private readonly deadline: number;
 private requests = 0;
 private readonly maxRequests: number;
 constructor(ms = 1200, maxRequests = 12) { this.deadline = performance.now() + ms; this.maxRequests = maxRequests; }
 remaining() { return this.requests > this.maxRequests ? 0 : Math.max(0, Math.floor(this.deadline - performance.now())); }
 check() { if (!this.remaining()) throw new Error('Hierarchy read budget exhausted'); }
 async run<T>(operation: () => Promise<T>, request = false): Promise<T> {
  const remaining = this.remaining();
  if (!remaining || (request && ++this.requests > this.maxRequests)) throw new Error('Hierarchy read budget exhausted');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Hierarchy read deadline exceeded')), remaining); })]); }
  finally { if (timer) clearTimeout(timer); }
 }
}
export const hierarchyDisclosure = 'Descendants of exited or unverifiable agents are unavailable; historical ancestry is not inferred.';
export async function readDescendants(page: any, source: TaskSource, initialRecords: any[], dependencies: {
 descriptor: (agentId: string) => Promise<unknown>;
 read: (source: TaskSource, cursor: string | undefined, budget: ReadBudget) => Promise<any>;
 verify: (source: TaskSource, budget: ReadBudget) => Promise<void>;
 records: (budget: ReadBudget) => Promise<any[]>;
 token: (pid: number) => string | null;
}, budget = new ReadBudget()) {
 const direct = page.items.map(({ source: _source, parentKey: _parent, ...row }: any) => ({ ...row, source }));
 const items = [...direct], visited = new Set([source.agentId]);
 const edges: { row: any; owner: TaskSource; child: TaskSource }[] = [];
 let partial = page.stale === true, exhausted = false;
 const unavailable = () => { partial = true; };
 async function visit(rows: any[], owner: TaskSource, depth: number) {
  const latest = new Map<string, any>();
  for (const row of rows) if (!latest.has(taskGroupKey(row)) || row.attempt > latest.get(taskGroupKey(row)).attempt) latest.set(taskGroupKey(row), row);
  for (const row of latest.values()) {
   if (depth >= 8 || edges.length >= 12 || items.length >= 200) { unavailable(); return; }
   if (row.stale === true || !row.runtimeId) { unavailable(); continue; }
   const route = resolveExactChildRuntime(owner.sessionId, row, initialRecords, dependencies.token);
   if (!route.available || !route.agentId || !route.workspaceId || visited.has(route.agentId)) { unavailable(); continue; }
   visited.add(route.agentId);
   try {
    const descriptor = await budget.run(() => dependencies.descriptor(route.agentId!));
    if (!validateHarnessReadOnlyDescriptor(descriptor, route.agentId)) { unavailable(); continue; }
    const child: TaskSource = { agentId: route.agentId, workspaceId: route.workspaceId, sessionId: descriptor.sessionId, runtimeEpoch: descriptor.runtimeEpoch };
    const childRows: any[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    for (let p = 0; ; p++) {
     const next = await budget.run(() => dependencies.read(child, cursor, budget), true);
     if (next?.state !== 'available' || next.stale === true || next.sessionId !== child.sessionId || !Array.isArray(next.items) || next.items.length > 50) throw new Error('Unavailable descendant inventory');
     childRows.push(...next.items);
     if (childRows.length + items.length > 200) throw new Error('Hierarchy row limit');
     if (!next.nextCursor) break;
     cursor = next.nextCursor;
     if (typeof cursor !== 'string' || cursors.has(cursor) || p >= 3) throw new Error('Hierarchy pagination limit');
     cursors.add(cursor);
    }
    // The edge belongs to the launching attempt, never to producer-supplied metadata.
    const projected = childRows.map(childRow => ({ ...childRow, paseoAgentId: undefined, paseoWorkspaceId: undefined, source: child, parentKey: treeAttemptKey(row) }));
    edges.push({ row, owner, child }); items.push(...projected);
    await visit(projected, child, depth + 1);
   } catch { unavailable(); if (!budget.remaining()) { exhausted = true; return; } }
  }
 }
 if (!partial) await visit(direct, source, 0);
 // A separate, bounded after-read snapshot revalidates every exposed edge. If
 // validation cannot finish, keep only direct rows, never unchecked descendants.
 const validation = new ReadBudget(300, 0);
 try {
  const records = await validation.run(() => dependencies.records(validation));
  const invalidSources = new Set<string>();
  for (const edge of edges) {
   const route = resolveExactChildRuntime(edge.owner.sessionId, edge.row, records, dependencies.token);
   try {
    if (!route.available || route.agentId !== edge.child.agentId || route.workspaceId !== edge.child.workspaceId) throw new Error('Stale ownership');
    await validation.run(() => dependencies.verify(edge.child, validation));
   } catch { invalidSources.add(edge.child.agentId); unavailable(); }
  }
  let retained = items.filter(item => !invalidSources.has(item.source.agentId));
  for (let depth = 0; depth <= 8; depth++) {
   const keys = new Set(retained.map(treeAttemptKey));
   retained = retained.filter(item => !item.parentKey || keys.has(item.parentKey));
  }
  // Public route hints also come from the final trusted snapshot.
  const result: any[] = [];
  for (let i = 0; i < retained.length; i += 50) for (const item of retained.slice(i, i + 50)) result.push(...correlateChildRoutes({ items: [item] }, item.source.sessionId, records, dependencies.token).items);
  return { ...page, items: result, hierarchyPartial: partial || exhausted, hierarchyMessage: partial || exhausted ? 'Some descendant inventories are unavailable (stale evidence or read limits). ' + hierarchyDisclosure : undefined };
 } catch {
  return { ...page, items: direct.map(({ paseoAgentId: _agent, paseoWorkspaceId: _workspace, ...row }: any) => row), hierarchyPartial: true, hierarchyMessage: 'Descendant verification exceeded its read budget; showing direct agents only. ' + hierarchyDisclosure };
 }
}
