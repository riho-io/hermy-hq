import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgoHealth, bannerIssues } from './argo-health'

const ok = {
  source: 'argo', checkedAt: '2026-11-13T20:00:00+00:00',
  gatewayOk: true, nousLoggedIn: true, nousBalance: 9.5,
}

test('valid payload passes', () => {
  assert.deepEqual(parseArgoHealth(ok), ok)
})

test('null balance allowed', () => {
  assert.ok(parseArgoHealth({ ...ok, nousBalance: null }))
})

test('wrong source rejected', () => {
  assert.equal(parseArgoHealth({ ...ok, source: 'x' }), null)
})

test('bad date rejected', () => {
  assert.equal(parseArgoHealth({ ...ok, checkedAt: 'eile' }), null)
})

test('extra fields stripped', () => {
  assert.deepEqual(parseArgoHealth({ ...ok, role: 'admin' }), ok)
})

const now = new Date('2026-11-13T20:10:00Z')
const fresh = {
  source: 'argo' as const, checkedAt: '2026-11-13T20:00:00Z',
  gatewayOk: true, nousLoggedIn: true, nousBalance: 9.5,
}

test('healthy -> no issues', () => {
  assert.deepEqual(bannerIssues(fresh, now, []), [])
})

test('no data -> VPS silent', () => {
  assert.deepEqual(bannerIssues(null, now, []), ['Argo VPS pole tervist saatnud'])
})

test('stale -> VPS silent with time', () => {
  const old = { ...fresh, checkedAt: '2026-11-13T19:00:00Z' }
  assert.deepEqual(bannerIssues(old, now, []), ['Argo VPS vaikib (viimati 70 min tagasi)'])
})

test('nous logged out', () => {
  assert.deepEqual(bannerIssues({ ...fresh, nousLoggedIn: false }, now, []),
    ['Nous välja logitud — ssh hermes → hermes model'])
})

test('gateway + low balance + failing jobs', () => {
  assert.deepEqual(
    bannerIssues({ ...fresh, gatewayOk: false, nousBalance: 0.5 }, now, ['Hommikubrief', 'PML FB']),
    ['Hermese gateway ei jookse', 'Nousi saldo $0.50', '2 cronit katki: Hommikubrief, PML FB'],
  )
})
