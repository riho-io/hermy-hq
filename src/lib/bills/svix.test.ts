import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifySvix } from './svix'

const secret = 'whsec_' + Buffer.from('test-secret-bytes-1234567890abcd').toString('base64')
const NOW = 1_800_000_000
const sign = (id: string, ts: number | string, body: string) =>
  'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')
const base = { secret, id: 'msg_1', timestamp: String(NOW), body: '{"a":1}', nowSec: NOW }

test('valid signature passes', () => {
  assert.equal(verifySvix({ ...base, signature: sign('msg_1', NOW, base.body) }), true)
})
test('tampered body fails', () => {
  assert.equal(verifySvix({ ...base, body: '{"a":2}', signature: sign('msg_1', NOW, '{"a":1}') }), false)
})
test('wrong secret fails', () => {
  const other = 'whsec_' + Buffer.from('another-secret-bytes-xxxxxxxxxxxx').toString('base64')
  assert.equal(verifySvix({ ...base, secret: other, signature: sign('msg_1', NOW, base.body) }), false)
})
test('old timestamp (replay) fails even with a valid signature', () => {
  const ts = NOW - 301
  assert.equal(verifySvix({ ...base, timestamp: String(ts), signature: sign('msg_1', ts, base.body) }), false)
})
test('future timestamp beyond window fails', () => {
  const ts = NOW + 301
  assert.equal(verifySvix({ ...base, timestamp: String(ts), signature: sign('msg_1', ts, base.body) }), false)
})
test('edge of window passes', () => {
  const ts = NOW - 300
  assert.equal(verifySvix({ ...base, timestamp: String(ts), signature: sign('msg_1', ts, base.body) }), true)
})
test('several signatures (key rotation): any valid one passes', () => {
  const sig = `v1,AAAA v2,BBBB ${sign('msg_1', NOW, base.body)}`
  assert.equal(verifySvix({ ...base, signature: sig }), true)
})
test('missing secret / header values fail closed', () => {
  const good = sign('msg_1', NOW, base.body)
  assert.equal(verifySvix({ ...base, secret: undefined, signature: good }), false)
  assert.equal(verifySvix({ ...base, id: null, signature: good }), false)
  assert.equal(verifySvix({ ...base, timestamp: null, signature: good }), false)
  assert.equal(verifySvix({ ...base, signature: null }), false)
  assert.equal(verifySvix({ ...base, timestamp: 'abc', signature: good }), false)
})
