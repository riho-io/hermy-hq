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
})
test('malformed timestamps fail on timestamp validation alone (each signed over its own string)', () => {
  for (const ts of ['abc', '1800000000.5', '0x6B49D200', ' 1800000000', '1.8e9']) {
    assert.equal(verifySvix({ ...base, timestamp: ts, signature: sign('msg_1', ts, base.body) }), false, ts)
  }
})
test('NaN nowSec fails closed', () => {
  assert.equal(verifySvix({ ...base, nowSec: NaN, signature: sign('msg_1', NOW, base.body) }), false)
})
test('future edge (NOW + 300) passes', () => {
  const ts = NOW + 300
  assert.equal(verifySvix({ ...base, timestamp: String(ts), signature: sign('msg_1', ts, base.body) }), true)
})
test('valid signature under a v2 prefix is rejected', () => {
  const sig = sign('msg_1', NOW, base.body).replace(/^v1,/, 'v2,')
  assert.equal(verifySvix({ ...base, signature: sig }), false)
})
test('Svix public documented test vector', () => {
  assert.equal(
    verifySvix({
      secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      timestamp: '1614265330',
      signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
      body: '{"test": 2432232314}',
      nowSec: 1614265330,
    }),
    true,
  )
})
