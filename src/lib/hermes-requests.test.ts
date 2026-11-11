import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRow, parsePayload, canTransition, fromStatuses, parseIdsParam } from './hermes-requests';

const row = (kind: string, status: string, prompt: string | null = JSON.stringify({ jobId: 'abcdef012345', profile: 'default' })) => ({
  kind,
  status,
  prompt,
});

test('oneshot row is rejected as unsupported', () => {
  assert.deepEqual(classifyRow(row('oneshot', 'queued')), { action: 'skip' }); // other features' rows are left alone
  assert.deepEqual(classifyRow(row('oneshot', 'approved')), { action: 'reject', error: 'not supported by the executor' });
});

test('cron.schedule: queued is not runnable, approved is', () => {
  const p = JSON.stringify({ jobId: 'abcdef012345', profile: 'default', schedule: '0 9 * * *' });
  assert.deepEqual(classifyRow(row('cron.schedule', 'queued', p)), { action: 'skip' });
  const r = classifyRow(row('cron.schedule', 'approved', p));
  assert.equal(r.action, 'return');
});

test('non-approval kind queued is runnable; other statuses skipped', () => {
  assert.equal(classifyRow(row('cron.pause', 'queued')).action, 'return');
  for (const s of ['awaiting_approval', 'running', 'done', 'failed', 'rejected']) {
    assert.equal(classifyRow(row('cron.pause', s)).action, 'skip', s);
  }
});

test('payload with jobId "-x" is invalid and gets rejected', () => {
  const bad = JSON.stringify({ jobId: '-x', profile: 'default' });
  assert.equal(parsePayload('cron.pause', bad), null);
  assert.deepEqual(classifyRow(row('cron.pause', 'queued', bad)), { action: 'reject', error: 'invalid payload' });
});

test('payload shape per kind', () => {
  const base = { jobId: 'abcdef012345', profile: 'default' };
  assert.deepEqual(parsePayload('cron.run', JSON.stringify(base)), base);
  assert.equal(parsePayload('cron.deliver', JSON.stringify(base)), null); // preset missing
  assert.deepEqual(parsePayload('cron.deliver', JSON.stringify({ ...base, preset: 'raport' })), { ...base, preset: 'raport' });
  assert.equal(parsePayload('cron.deliver', JSON.stringify({ ...base, preset: 'x' })), null);
  assert.equal(parsePayload('cron.schedule', JSON.stringify({ ...base, schedule: '-rf' })), null);
  assert.equal(parsePayload('cron.pause', null), null);
  assert.equal(parsePayload('cron.pause', 'not json'), null);
});

test('transitions', () => {
  assert.equal(canTransition('queued', 'running', 'cron.pause'), true);
  assert.equal(canTransition('approved', 'running', 'cron.schedule'), true);
  assert.equal(canTransition('queued', 'running', 'cron.schedule'), false); // needs approval
  assert.equal(canTransition('running', 'running', 'cron.pause'), false);
  assert.equal(canTransition('queued', 'done', 'cron.pause'), false);
  assert.equal(canTransition('running', 'done', 'cron.pause'), true);
  assert.equal(canTransition('running', 'failed', 'cron.pause'), true);
  assert.equal(canTransition('done', 'failed', 'cron.pause'), false);
  assert.deepEqual(fromStatuses('done'), ['running']);
  assert.deepEqual(fromStatuses('running'), ['queued', 'approved']);
});

test('parseIdsParam: cuid-ish ids, max 20, anything else rejected', () => {
  assert.equal(parseIdsParam(null), null); // absent -> no filter
  assert.deepEqual(parseIdsParam('cmabc123def456ghi789jkl0,cmxyz987'), ['cmabc123def456ghi789jkl0', 'cmxyz987']);
  assert.equal(parseIdsParam(''), 'invalid');
  assert.equal(parseIdsParam('a,,b'), 'invalid');
  assert.equal(parseIdsParam('abc;drop'), 'invalid');
  assert.equal(parseIdsParam('ABC'), 'invalid');
  assert.equal(parseIdsParam('x'.repeat(41)), 'invalid');
  assert.equal(parseIdsParam(Array.from({ length: 21 }, (_, i) => `c${i}abc`).join(',')), 'invalid');
  assert.equal(parseIdsParam(Array.from({ length: 20 }, (_, i) => `c${i}abc`).join(','))?.length, 20);
});
