import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSubagentAttempts, attemptIdentity } from '../client/subagent-attempts.ts';
const row = (taskId: string, attempt: number, status = 'lost') => ({taskId, attempt, childId: `child-${taskId}-${attempt}`, runtimeId: `runtime-${attempt}`, status, title: 'Same name'});
test('stable task groups use latest attempt independent of page order or display name', () => {
 const old = row('a', 1), latest = row('a', 2, 'running'), unrelated = row('b', 1);
 for (const input of [[old, unrelated, latest], [latest, old, unrelated]]) {
  const groups = groupSubagentAttempts(input);
  assert.equal(groups.size, 2);
  assert.deepEqual(groups.get('a'), [latest, old]);
  assert.deepEqual(groups.get('b'), [unrelated]);
  assert.equal(groups.get('a')![0].status, 'running');
 }
});
test('counting grouped rows cannot inflate badge or completed totals with historical attempts', () => {
 const rows = [row('a', 1, 'lost'), row('a', 2, 'running'), row('b', 1, 'running'), row('b', 2, 'completed')];
 const latest = [...groupSubagentAttempts(rows).values()].map(attempts => attempts[0]);
 assert.equal(latest.length, 2);
 assert.equal(latest.filter(item => item.status === 'running').length, 1);
 assert.equal(latest.filter(item => item.status === 'completed').length, 1);
});
test('trace identity binds task, child, attempt and runtime', () => {
 const item = row('a', 1);
 for (const change of [{taskId:'b'}, {childId:'other'}, {attempt:2}, {runtimeId:'other'}]) assert.notEqual(attemptIdentity(item), attemptIdentity({...item, ...change}));
});
