import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELIVER_PRESETS, isAllowed, requiresApproval, jobIdSchema, profileSchema, presetSchema, scheduleSchema } from './hermes-actions';

test('approval rules', () => {
  for (const k of ['cron.pause', 'cron.resume', 'cron.run', 'cron.deliver']) assert.equal(requiresApproval(k), false, k);
  assert.equal(requiresApproval('cron.schedule'), true);
  assert.equal(requiresApproval('oneshot'), true); // unknown kinds never skip approval
});

test('allowlist', () => {
  assert.equal(isAllowed('cron.deliver'), true);
  for (const k of ['oneshot', 'chat', 'memory.write', 'onboarding.write', 'cron.create', 'cron.edit', 'cron.remove', 'constructor', '']) {
    assert.equal(isAllowed(k), false, k);
  }
});

test('presets', () => {
  assert.deepEqual([...DELIVER_PRESETS], ['raport', 'hoiatus', 'vait']);
  assert.equal(presetSchema.safeParse('raport').success, true);
  assert.equal(presetSchema.safeParse('telegram:1').success, false);
});

test('jobId, profile, schedule validation', () => {
  assert.equal(jobIdSchema.safeParse('0123456789ab').success, true);
  for (const bad of ['0123456789AB', '0123456789a', '--help', '0123456789ab ']) assert.equal(jobIdSchema.safeParse(bad).success, false, bad);
  assert.equal(profileSchema.safeParse('default').success, true);
  for (const bad of ['', 'A', 'a b', '../x', 'a'.repeat(33), '-p']) assert.equal(profileSchema.safeParse(bad).success, false, bad);
  assert.equal(scheduleSchema.safeParse('*/5 * * * *').success, true);
  assert.equal(scheduleSchema.safeParse('every 2h').success, true);
  for (const bad of ['0 9 * * *; rm', '$(id)', 'a'.repeat(65), '', '`x`']) assert.equal(scheduleSchema.safeParse(bad).success, false, bad);
});
