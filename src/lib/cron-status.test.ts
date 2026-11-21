import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CronJob } from '../app/api/hermes/crons/route'
import { isStale, dataHealth, jobState, needsAttention, ago, until } from './cron-status'

const NOW = Date.parse('2026-11-21T10:00:00Z') // 12:00 Tallinn
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString()

const job = (over: Partial<CronJob> = {}): CronJob => ({
  id: 'j1', profile: 'default', name: 'Test', status: 'active', schedule: '*/30 * * * *',
  nextRun: iso(20), lastRun: iso(-10), lastStatus: 'ok', lastError: null, failureStreak: 0,
  telegram: 'vait', ...over,
})

/* freshness: the negative tests the old /hermes page lacked */
test('fresh sync is not stale', () => {
  assert.equal(isStale(iso(-5), NOW), false)
  assert.deepEqual(dataHealth(null, iso(-5), NOW), { kind: 'ok' })
})

test('sync older than 15 min is stale and shows banner', () => {
  assert.equal(isStale(iso(-16), NOW), true)
  const h = dataHealth(null, iso(-16), NOW)
  assert.equal(h.kind, 'stale')
  assert.match(h.kind === 'stale' ? h.message : '', /Andmed ei uuene/)
})

test('missing or broken syncedAt is stale, never silent', () => {
  assert.equal(isStale(null, NOW), true)
  assert.equal(isStale('eile', NOW), true)
  assert.equal(dataHealth(null, null, NOW).kind, 'stale')
})

test('fetch failure wins over fresh data', () => {
  const h = dataHealth('HTTP 500', iso(-1), NOW)
  assert.equal(h.kind, 'failed')
  assert.match(h.kind === 'failed' ? h.message : '', /HTTP 500/)
  const empty = dataHealth('HTTP 500', null, NOW, false)
  assert.equal(empty.kind, 'failed')
  assert.doesNotMatch(empty.kind === 'failed' ? empty.message : '', /viimast/)
})

/* job state */
test('ok job', () => {
  assert.equal(jobState(job(), iso(-1), NOW), 'ok')
  assert.equal(needsAttention(job(), iso(-1), NOW), false)
})

test('error, paused, late', () => {
  assert.equal(jobState(job({ lastStatus: 'error' }), iso(-1), NOW), 'error')
  assert.equal(jobState(job({ status: 'paused', lastStatus: 'error' }), iso(-1), NOW), 'paused')
  assert.equal(jobState(job({ nextRun: iso(-11) }), iso(0), NOW), 'late')
  assert.equal(jobState(job({ nextRun: iso(-5) }), iso(0), NOW), 'ok') // inside 10 min grace
})

test('late is measured from sync time, not clock', () => {
  // sync 30 min ago, nextRun 20 min ago: was in the future at sync time -> not late
  assert.equal(jobState(job({ nextRun: iso(-20) }), iso(-30), NOW), 'ok')
})

test('failureStreak alone needs attention', () => {
  assert.equal(needsAttention(job({ failureStreak: 2 }), iso(-1), NOW), true)
})

/* relative times, Europe/Tallinn */
test('relative Estonian times', () => {
  assert.equal(ago(iso(-2), NOW), '2 min tagasi')
  assert.equal(until(iso(60), NOW), '1 h pärast')
  assert.equal(until('2026-11-22T06:00:00Z', NOW), 'homme 08:00')
  assert.equal(ago('2026-11-20T18:30:00Z', NOW), 'eile 20:30')
  assert.equal(until(iso(-40), NOW), '40 min hiljaks')
})
