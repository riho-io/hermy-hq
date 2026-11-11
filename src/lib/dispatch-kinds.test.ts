import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchAccepts } from './dispatch-kinds';
import { requiresApproval } from './hermes-actions';

test('dispatch rejects every cron kind', () => {
  for (const k of ['cron.create', 'cron.edit', 'cron.remove', 'cron.pause', 'cron.resume', 'cron.run', 'cron.deliver', 'cron.schedule']) {
    assert.equal(dispatchAccepts(k), false, k);
  }
});

test('dispatch rejects blocked and non-cron kinds', () => {
  for (const k of ['oneshot', 'chat', 'memory.write', 'onboarding.write', '', 'constructor']) {
    assert.equal(dispatchAccepts(k), false, k);
  }
  // The executor supports none of these, so dispatch is closed for every kind.
  for (const k of ['kanban', 'goal', 'briefing.generate', 'model.set', 'journey.fetch']) {
    assert.equal(dispatchAccepts(k), false, k);
  }
});

test('dispatch kinds fail closed to approval', () => {
  for (const k of ['kanban', 'goal', 'briefing.generate', 'model.set', 'journey.fetch']) {
    assert.equal(requiresApproval(k), true, k);
  }
});
