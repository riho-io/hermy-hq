import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processBill, stripNul, DAILY_LLM_CAP, type InboundStore, type BillIo, type BillInput, type BillUpdate } from './inbound'

const KEY = 'a'.repeat(64)
const inp = (over: Partial<BillInput> = {}): BillInput => ({
  messageKey: KEY,
  from: 'Näidis <noreply@naide.example>',
  subject: 'Arve nr 1',
  account: 'gmail',
  bodyText: 'Tere, arve lisatud.',
  pdf: null,
  ...over,
})
const goodJson = JSON.stringify({
  isBill: true, confidence: 0.9, supplier: 'Näidis OÜ', amount: 10, currency: 'EUR', dueDate: '2026-12-05',
  reference: null, iban: null, contractNo: null, serviceAddress: 'Näidise 5, Jõhvi', payUrl: null,
})
const PDF = { filename: 'arve.pdf', contentType: 'application/pdf' as const, data: Buffer.from('%PDF-1.4 x') }

function harness(over: { llm?: () => Promise<string>; used?: number; claimed?: boolean; pdfText?: string; saveFileThrows?: boolean } = {}) {
  const rows: { id: string; update?: BillUpdate; file?: boolean } = { id: 'bill_1' }
  const log: string[] = []
  const store: InboundStore = {
    claim: async () => { log.push('claim'); return over.claimed === false ? null : 'bill_1' },
    update: async (_id, patch) => { log.push('update'); rows.update = patch },
    saveFile: async () => {
      log.push('saveFile')
      if (over.saveFileThrows) throw new Error('db down: secret query context')
      rows.file = true
    },
    groups: async () => { log.push('groups'); return [{ id: 'kodu', keywords: ['Näidise 5'], sortOrder: 0 }] },
    extractionsLast24h: async () => { log.push('extractionsLast24h'); return over.used ?? 1 },
  }
  const io: BillIo = {
    pdfToText: async () => { log.push('pdfToText'); return over.pdfText ?? 'PDF tekst' },
    llm: async () => { log.push('llm'); return over.llm ? over.llm() : goodJson },
  }
  return { rows, store, io, log, calls: () => log.filter((c) => c === 'llm').length }
}

test('claim gets emailId imap:<messageKey>', async () => {
  const h = harness()
  let got: { emailId: string } | undefined
  h.store.claim = async (m) => { got = m; return 'bill_1' }
  await processBill(inp(), h.store, h.io)
  assert.equal(got?.emailId, `imap:${KEY}`)
})
test('duplicate webhook delivery does nothing: no LLM', async () => {
  const h = harness({ claimed: false })
  assert.equal(await processBill(inp(), h.store, h.io), 'duplicate')
  assert.deepEqual(h.log, ['claim'])
})
test('claim happens before any LLM call', async () => {
  const h = harness()
  await processBill(inp(), h.store, h.io)
  const c = h.log.indexOf('claim')
  assert.equal(c, 0)
  assert.ok(h.log.indexOf('llm') > c)
})
test('happy path: bill is new, grouped by keyword, PDF saved', async () => {
  const h = harness()
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'new')
  assert.equal(h.rows.update?.status, 'new')
  assert.equal(h.rows.update?.amountCents, 1000)
  assert.equal(h.rows.update?.groupId, 'kodu')
  assert.equal(h.rows.file, true)
})
test('non-bill is ignored and its PDF is NOT stored', async () => {
  const h = harness({ llm: async () => JSON.stringify({ ...JSON.parse(goodJson), isBill: false }) })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'ignored')
  assert.equal(h.rows.update?.status, 'ignored')
  assert.equal(h.rows.file, undefined)
})
test('ignored non-bill stores only status + reason, extracted fields are nulled', async () => {
  const h = harness({
    llm: async () => JSON.stringify({
      ...JSON.parse(goodJson), isBill: false, reference: 'R-1', iban: 'EE382200221020145685',
      contractNo: 'L-9', payUrl: 'https://pay.example/x',
    }),
  })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'ignored')
  const u = h.rows.update!
  assert.equal(u.status, 'ignored')
  assert.ok(u.ignoreReason)
  assert.deepEqual(
    { supplier: u.supplier, amountCents: u.amountCents, reference: u.reference, iban: u.iban, contractNo: u.contractNo,
      serviceAddress: u.serviceAddress, payUrl: u.payUrl, groupId: u.groupId, dueDate: u.dueDate, currency: u.currency },
    { supplier: null, amountCents: null, reference: null, iban: null, contractNo: null,
      serviceAddress: null, payUrl: null, groupId: null, dueDate: null, currency: 'EUR' },
  )
})
test('saveFile failing after update still returns the decided status', async () => {
  const h = harness({ saveFileThrows: true })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'new')
  assert.equal(h.rows.update?.status, 'new')
})
test('errors are logged by name only, never message', async () => {
  const h = harness({ llm: async () => { throw new Error('secret prisma query context') } })
  const orig = console.error
  const logged: unknown[][] = []
  console.error = (...a: unknown[]) => { logged.push(a) }
  try {
    assert.equal(await processBill(inp(), h.store, h.io), 'review')
  } finally {
    console.error = orig
  }
  assert.ok(logged.length > 0)
  assert.ok(!JSON.stringify(logged).includes('secret'))
})
test('LLM garbage leaves a review row (never lost)', async () => {
  const h = harness({ llm: async () => 'sorry I cannot' })
  assert.equal(await processBill(inp(), h.store, h.io), 'review')
  assert.equal(h.rows.update, undefined) // claim row already has status review
})
test('LLM throwing leaves a review row (never lost)', async () => {
  const h = harness({ llm: async () => { throw new Error('boom') } })
  assert.equal(await processBill(inp(), h.store, h.io), 'review')
})
test('daily cap reached: no LLM call, row stays review', async () => {
  const h = harness({ used: DAILY_LLM_CAP })
  assert.equal(await processBill(inp(), h.store, h.io), 'review')
  assert.equal(h.calls(), 0)
})
test('an injected instruction in the email cannot change the schema of the result', async () => {
  const h = harness({ llm: async () => JSON.stringify({ ...JSON.parse(goodJson), status: 'paid', role: 'admin' }) })
  const out = await processBill(inp(), h.store, h.io)
  assert.equal(out, 'new')
  assert.equal((h.rows.update as unknown as Record<string, unknown>).role, undefined)
  assert.equal(h.rows.update?.status, 'new')
})

test('pdf present but unreadable (empty text) and LLM says not a bill -> review, PDF saved', async () => {
  const h = harness({ pdfText: '', llm: async () => JSON.stringify({ ...JSON.parse(goodJson), isBill: false }) })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'review')
  assert.equal(h.rows.update?.status, 'review')
  assert.equal(h.rows.file, true)
})
test('pdf with text and LLM says not a bill -> ignored, no file', async () => {
  const h = harness({ pdfText: 'Päris tekst', llm: async () => JSON.stringify({ ...JSON.parse(goodJson), isBill: false }) })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'ignored')
  assert.equal(h.rows.file, undefined)
})
test('pdfToText throwing is logged and does not crash', async () => {
  const h = harness()
  h.io.pdfToText = async () => { throw new TypeError('x') }
  const warns: unknown[][] = []
  const orig = console.warn
  console.warn = (...a: unknown[]) => { warns.push(a) }
  try {
    await processBill(inp({ pdf: PDF }), h.store, h.io)
  } finally {
    console.warn = orig
  }
  assert.deepEqual(warns, [['inbound pdf text failed', 'TypeError']])
})
test('catch-all log names the failing step', async () => {
  const h = harness({ llm: async () => { throw new Error('deepseek 503') } })
  const errs: unknown[][] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { errs.push(a) }
  try {
    assert.equal(await processBill(inp(), h.store, h.io), 'review')
  } finally {
    console.error = orig
  }
  const line = errs.map((a) => a.join(' ')).join('\n')
  assert.match(line, /inbound bill failed step=llm/)
  assert.match(line, /deepseek 503/)
})
test('catch-all log never includes non-static messages', async () => {
  const h = harness({ llm: async () => { throw new Error('secret mail content') } })
  const errs: unknown[][] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { errs.push(a) }
  try {
    await processBill(inp(), h.store, h.io)
  } finally {
    console.error = orig
  }
  const line = errs.map((a) => a.join(' ')).join('\n')
  assert.match(line, /step=llm/)
  assert.doesNotMatch(line, /secret/)
})
test('stripNul removes NUL characters', () => {
  assert.equal(stripNul('a\u0000b\u0000'), 'ab')
})
test('claim receives NUL-free fromAddr and subject', async () => {
  const h = harness()
  let got: { fromAddr: string; subject: string } | undefined
  h.store.claim = async (m) => { got = m; return 'bill_1' }
  await processBill(inp({ from: 'a\u0000b <noreply@naide.example>', subject: 'x\u0000y' }), h.store, h.io)
  assert.ok(got)
  assert.ok(!got.fromAddr.includes('\u0000') && !got.subject.includes('\u0000'))
})
