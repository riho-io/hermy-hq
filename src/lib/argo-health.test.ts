import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgoHealth } from './argo-health'

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
