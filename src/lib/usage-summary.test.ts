import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tallinnDay, periodStartDay, summarize, usageHealth, fmtUsd, fmtTokens,
  type UsageDay, type UsageProfile,
} from './usage-summary'

const NOW = Date.parse('2026-11-21T10:00:00Z') // 12:00 Tallinn
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString()

const day = (over: Partial<UsageDay> = {}): UsageDay => ({
  profile: 'default', day: '2026-11-21', sessions: 3, emptySessions: 1, unpricedSessions: 0, subscriptionSessions: 0,
  tokens: 1000, costUsd: 0.01, subscriptionCostUsd: null, models: [], platforms: { cron: 3 }, ...over,
})
const prof = (over: Partial<UsageProfile> = {}): UsageProfile => ({
  profile: 'default', displayName: 'Argo', model: 'z-ai/glm-5.3-flash', provider: 'nous', subscription: false,
  gateway: 'running', cronCount: 36, cronEnabled: 35, ...over,
})

test('Tallinn day boundary', () => {
  assert.equal(tallinnDay(Date.parse('2026-11-20T22:30:00Z')), '2026-11-21')
  assert.equal(tallinnDay(Date.parse('2026-11-20T21:30:00Z')), '2026-11-20')
})

test('period start days', () => {
  assert.equal(periodStartDay('today', NOW), '2026-11-21')
  assert.equal(periodStartDay('7d', NOW), '2026-11-15')
  assert.equal(periodStartDay('30d', NOW), '2026-10-23')
})

test('totals respect the period and exclude subscription from known cost', () => {
  const days = [
    day(),
    day({ day: '2026-11-16', costUsd: 0.1, tokens: 500, unpricedSessions: 2 }),
    day({ day: '2026-11-01', costUsd: 5, tokens: 9 }),
    day({ profile: 'tark', costUsd: null, subscriptionCostUsd: 0.4, subscriptionSessions: 1, tokens: 300 }),
  ]
  const profiles = [prof(), prof({ profile: 'tark', displayName: null, model: 'sonnet', subscription: true })]
  const today = summarize(days, profiles, 'today', NOW)
  assert.equal(today.totals.costUsd, 0.01)
  assert.equal(today.totals.tokens, 1300)
  assert.equal(today.totals.unpricedSessions, 0)
  const week = summarize(days, profiles, '7d', NOW)
  assert.ok(Math.abs(week.totals.costUsd - 0.11) < 1e-9)
  assert.equal(week.totals.unpricedSessions, 2)
  assert.equal(summarize(days, profiles, '30d', NOW).totals.tokens, 1809)
})

test('profile rows: label, alias, subscription, sorted by tokens', () => {
  const s = summarize([day(), day({ profile: 'tark', tokens: 5000, costUsd: null })],
    [prof(), prof({ profile: 'tark', displayName: null, model: 'sonnet', subscription: true, cronCount: 1, cronEnabled: 1 })], '7d', NOW)
  assert.deepEqual(s.rows.map((r) => [r.profile, r.label, r.alias]), [['tark', 'tark', null], ['default', 'Argo', 'default']])
  assert.equal(s.rows[0].subscription, true)
  assert.equal(s.rows[0].costUsd, null)
  assert.equal(s.maxTokens, 5000)
})

test('profiles without usage rows still appear with zeros (never hidden)', () => {
  const s = summarize([], [prof({ profile: 'email', displayName: 'Kuller' })], '7d', NOW)
  assert.equal(s.rows.length, 1)
  assert.equal(s.rows[0].sessions, 0)
  assert.equal(s.totals.costUsd, 0)
})

test('attention: unpriced, idle, gateway down', () => {
  const s = summarize(
    [day({ unpricedSessions: 4 })],
    [prof(), prof({ profile: 'email', displayName: 'Kuller' }), prof({ profile: 'hoidja', displayName: 'Varahoidja', gateway: 'stopped' })],
    '7d', NOW,
  )
  const kinds = s.attention.map((a) => a.kind)
  assert.deepEqual(kinds, ['unpriced', 'gateway', 'idle'])
  assert.match(s.attention[0].text, /4 sessiooni ilma hinnata/)
  assert.match(s.attention[0].text, /alahinnatud/)
  assert.match(s.attention[2].text, /Kuller/)
  assert.match(s.attention[2].text, /Varahoidja/)
})

test('unknown gateway is not reported as down', () => {
  const s = summarize([day()], [prof({ gateway: null })], '7d', NOW)
  assert.equal(s.attention.length, 0)
})

test('health: fresh, stale after 3 h, never-synced, fetch failure', () => {
  assert.deepEqual(usageHealth(null, iso(-60), NOW), { kind: 'ok' })
  assert.equal(usageHealth(null, iso(-181), NOW).kind, 'stale')
  const never = usageHealth(null, null, NOW)
  assert.equal(never.kind, 'stale')
  assert.match(never.kind === 'stale' ? never.message : '', /pole kordagi/)
  const f = usageHealth('HTTP 500', iso(-1), NOW)
  assert.equal(f.kind, 'failed')
  assert.match(f.kind === 'failed' ? f.message : '', /HTTP 500/)
})

test('formatting', () => {
  assert.equal(fmtUsd(0.1299), '$0.13')
  assert.equal(fmtUsd(0.0047), '$0.0047')
  assert.equal(fmtUsd(0), '$0')
  assert.equal(fmtUsd(null), '—')
  assert.equal(fmtTokens(1_608_319), '1,6 M')
  assert.equal(fmtTokens(52_978), '53 k')
  assert.equal(fmtTokens(840), '840')
})
