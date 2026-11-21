import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseExtraction, buildPrompt, decideStatus, toCents, MAX_INPUT_CHARS } from './extract'

const good = {
  isBill: true, confidence: 0.9, supplier: 'Näidis Energia OÜ', amount: 45.2, currency: 'EUR',
  dueDate: '2026-12-05', reference: '1234567', iban: 'EE382200221020145685',
  contractNo: 'K-100', serviceAddress: 'Näidise 5, Jõhvi', payUrl: 'https://naide.example/pay/1',
}

test('parses a valid object, also inside a code fence', () => {
  assert.deepEqual(parseExtraction(JSON.stringify(good)), good)
  assert.deepEqual(parseExtraction('```json\n' + JSON.stringify(good) + '\n```'), good)
})
test('garbage, wrong types and missing keys give null', () => {
  assert.equal(parseExtraction('not json'), null)
  assert.equal(parseExtraction(JSON.stringify({ ...good, amount: '45' })), null)
  assert.equal(parseExtraction(JSON.stringify({ ...good, dueDate: '2026-13-45' })), null)
  assert.equal(parseExtraction(JSON.stringify({ isBill: true })), null)
})
test('http or javascript payUrl is rejected', () => {
  assert.equal(parseExtraction(JSON.stringify({ ...good, payUrl: 'http://x.example/p' })), null)
  assert.equal(parseExtraction(JSON.stringify({ ...good, payUrl: 'javascript:alert(1)' })), null)
})
test('overlong strings are clipped, not trusted', () => {
  const e = parseExtraction(JSON.stringify({ ...good, supplier: 'x'.repeat(500) }))
  assert.equal(e?.supplier?.length, 120)
})
test('negative or absurd amount is rejected', () => {
  assert.equal(parseExtraction(JSON.stringify({ ...good, amount: -1 })), null)
  assert.equal(parseExtraction(JSON.stringify({ ...good, amount: 5_000_000 })), null)
})

test('decideStatus: non-bill is ignored', () => {
  const r = decideStatus({ ...good, isBill: false })
  assert.equal(r.status, 'ignored')
  assert.match(r.reason ?? '', /arve/)
})
test('decideStatus: complete confident bill is new', () => {
  assert.equal(decideStatus(good).status, 'new')
})
test('decideStatus: missing amount, missing due date or low confidence goes to review', () => {
  assert.equal(decideStatus({ ...good, amount: null }).status, 'review')
  assert.equal(decideStatus({ ...good, dueDate: null }).status, 'review')
  assert.equal(decideStatus({ ...good, confidence: 0.59 }).status, 'review')
})
test('toCents rounds half-cent amounts', () => {
  assert.equal(toCents(45.2), 4520)
  assert.equal(toCents(0.1 + 0.2), 30)
  assert.equal(toCents(null), null)
})

test('buildPrompt caps the total input and marks email as untrusted data', () => {
  const p = buildPrompt({ from: 'a@b.example', subject: 's'.repeat(2000), bodyText: 'b'.repeat(50_000), pdfText: 'p'.repeat(50_000) })
  assert.ok(p.user.length <= MAX_INPUT_CHARS + 500)
  assert.match(p.system, /untrusted/i)
  assert.match(p.user, /<email>/)
})
test('buildPrompt keeps PDF text when the body is long', () => {
  const p = buildPrompt({ from: 'a@b.example', subject: 'Arve', bodyText: 'b'.repeat(50_000), pdfText: 'PDF-MARKER' })
  assert.match(p.user, /PDF-MARKER/)
})
