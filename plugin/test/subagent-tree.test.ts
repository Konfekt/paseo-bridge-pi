import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTaskTree, treeAttemptKey, taskGroupKey } from '../shared/subagent-tree.ts';
import { groupSubagentAttempts, attemptIdentity } from '../client/subagent-attempts.ts';
const source = { agentId: 'owner', workspaceId: 'workspace', sessionId: 'session', runtimeEpoch: 'epoch' };
const row = (taskId: string, attempt = 1) => ({ taskId, childId: `child-${taskId}-${attempt}`, runtimeId: `runtime-${attempt}`, attempt, source, title: 'Same name' });
test('verified edges produce preorder and actual depths independent of names and inventory order', () => {
 const parent = row('parent'), sibling = row('sibling');
 const child = { ...row('child'), parentKey: treeAttemptKey(parent) };
 const grandchild = { ...row('grandchild'), parentKey: treeAttemptKey(child) };
 assert.deepEqual(orderTaskTree([grandchild, parent, sibling, child]).map(({row, depth}) => [row.taskId, depth]), [['parent', 0], ['child', 1], ['grandchild', 2], ['sibling', 0]]);
});
test('unavailable parents, stale attempts, cycles and excessive depth do not manufacture peer relations', () => {
 const old = row('parent'), latest = row('parent', 2);
 const child = { ...row('child'), parentKey: treeAttemptKey(old) };
 assert.deepEqual(orderTaskTree([latest, child]).map(x => x.row.taskId), ['parent']);
 const a = { ...row('a'), parentKey: treeAttemptKey(row('b')) }, b = { ...row('b'), parentKey: treeAttemptKey(row('a')) };
 assert.deepEqual(orderTaskTree([a, b]), []);
 const rows: any[] = [row('0')];
 for (let i = 1; i < 20; i++) rows.push({ ...row(String(i)), parentKey: treeAttemptKey(rows[i - 1]) });
 assert.equal(orderTaskTree(rows).length, 9);
});
test('source parent session and epoch bind grouping and every trace attempt', () => {
 const current = row('task');
 for (const key of ['agentId', 'workspaceId', 'sessionId', 'runtimeEpoch'] as const) {
  const other = { ...current, source: { ...source, [key]: 'changed' } };
  assert.notEqual(taskGroupKey(current), taskGroupKey(other));
  assert.notEqual(attemptIdentity(current), attemptIdentity(other));
  assert.equal(groupSubagentAttempts([current, other]).size, 2);
 }
 const latest = { ...current, attempt: 2 };
 assert.deepEqual([...groupSubagentAttempts([current, latest]).values()], [[latest, current]]);
});
