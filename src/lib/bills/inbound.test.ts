import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processBill, stripNul, isGarbageText, DAILY_LLM_CAP, MAX_PDF_BYTES, type InboundStore, type BillIo, type BillInput, type BillUpdate } from './inbound'

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
const TEXT = Array.from({ length: 40 }, (_, i) => `sõna${i}`).join(' ')
const GARBAGE = `!" ""#"$! % &' ()*+ ,-./ !" ""#"$! % &' ()*+`
const PDF = { filename: 'arve.pdf', contentType: 'application/pdf' as const, data: Buffer.from('%PDF-1.4 x') }

function harness(over: { llm?: () => Promise<string>; vision?: () => Promise<string>; used?: number; claimed?: boolean; pdfText?: string; saveFileThrows?: boolean; dup?: boolean | 'throw' } = {}) {
  const dupCalls: Parameters<InboundStore['findDuplicate']>[0][] = []
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
    findDuplicate: async (m) => {
      log.push('findDuplicate')
      dupCalls.push(m)
      if (over.dup === 'throw') throw new Error('db down: secret query context')
      return over.dup === true
    },
  }
  const io: BillIo = {
    pdfToText: async () => { log.push('pdfToText'); return over.pdfText ?? TEXT },
    llm: async () => { log.push('llm'); return over.llm ? over.llm() : goodJson },
    pdfVision: async () => { log.push('vision'); return over.vision ? over.vision() : goodJson },
  }
  return { rows, store, io, log, dupCalls, calls: () => log.filter((c) => c === 'llm').length, visions: () => log.filter((c) => c === 'vision').length }
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

test('pdf unreadable, vision unparsable, LLM says not a bill -> review, PDF saved', async () => {
  const h = harness({ pdfText: '', vision: async () => 'not json', llm: async () => JSON.stringify({ ...JSON.parse(goodJson), isBill: false }) })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'review')
  assert.equal(h.rows.update?.status, 'review')
  assert.equal(h.rows.file, true)
})
test('pdf with text and LLM says not a bill -> ignored, no file', async () => {
  const h = harness({ pdfText: TEXT, llm: async () => JSON.stringify({ ...JSON.parse(goodJson), isBill: false }) })
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
test('duplicate bill (same supplier, amount, due date) is ignored as duplikaat, nulled, no PDF saved', async () => {
  const h = harness({ dup: true })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'ignored')
  assert.deepEqual(h.dupCalls, [{ excludeId: 'bill_1', supplier: 'Näidis OÜ', amountCents: 1000, dueDate: '2026-12-05' }])
  const u = h.rows.update
  assert.equal(u?.status, 'ignored')
  assert.equal(u?.ignoreReason, 'duplikaat')
  assert.equal(u?.supplier, null)
  assert.equal(u?.amountCents, null)
  assert.equal(u?.dueDate, null)
  assert.equal(u?.reference, null)
  assert.equal(u?.iban, null)
  assert.equal(u?.contractNo, null)
  assert.equal(u?.serviceAddress, null)
  assert.equal(u?.payUrl, null)
  assert.equal(u?.groupId, null)
  assert.equal(u?.currency, 'EUR')
  assert.equal(h.rows.file, undefined)
  assert.ok(!h.log.includes('saveFile'))
})
test('not a duplicate: bill stays new and PDF is saved', async () => {
  const h = harness({ dup: false })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'new')
  assert.equal(h.dupCalls.length, 1)
  assert.equal(h.rows.update?.status, 'new')
  assert.equal(h.rows.file, true)
})
test('different amount or due date is passed to findDuplicate as-is', async () => {
  const a = harness({ llm: async () => JSON.stringify({ ...JSON.parse(goodJson), amount: 12.5 }) })
  assert.equal(await processBill(inp(), a.store, a.io), 'new')
  assert.equal(a.dupCalls[0].amountCents, 1250)
  const b = harness({ llm: async () => JSON.stringify({ ...JSON.parse(goodJson), dueDate: '2027-01-10' }) })
  assert.equal(await processBill(inp(), b.store, b.io), 'new')
  assert.equal(b.dupCalls[0].dueDate, '2027-01-10')
})
test('supplier is trimmed before the duplicate lookup', async () => {
  const h = harness({ llm: async () => JSON.stringify({ ...JSON.parse(goodJson), supplier: '  Näidis OÜ ' }) })
  await processBill(inp(), h.store, h.io)
  assert.equal(h.dupCalls[0].supplier, 'Näidis OÜ')
})
test('missing dueDate: findDuplicate is not called, bill goes to review', async () => {
  const h = harness({ dup: true, llm: async () => JSON.stringify({ ...JSON.parse(goodJson), dueDate: null }) })
  assert.equal(await processBill(inp(), h.store, h.io), 'review')
  assert.ok(!h.log.includes('findDuplicate'))
  assert.equal(h.rows.update?.status, 'review')
})
test('findDuplicate throwing does not lose the bill and logs step=dedupe', async () => {
  const h = harness({ dup: 'throw' })
  const errs: unknown[][] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { errs.push(a) }
  try {
    assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'new')
  } finally {
    console.error = orig
  }
  const line = errs.map((a) => a.join(' ')).join('\n')
  assert.match(line, /inbound bill failed step=dedupe/)
  assert.doesNotMatch(line, /secret/)
  assert.equal(h.rows.update?.status, 'new')
  assert.equal(h.rows.file, true)
})
test('non-bill never calls findDuplicate', async () => {
  const h = harness({ dup: true, llm: async () => JSON.stringify({ ...JSON.parse(goodJson), isBill: false }) })
  assert.equal(await processBill(inp(), h.store, h.io), 'ignored')
  assert.ok(!h.log.includes('findDuplicate'))
})

// --- garbage-text heuristic ---
test('isGarbageText: empty and whitespace are garbage', () => {
  assert.equal(isGarbageText(''), true)
  assert.equal(isGarbageText('  \n '), true)
})
test('isGarbageText: broken glyph output is garbage', () => {
  assert.equal(isGarbageText(GARBAGE.repeat(20)), true)
})
test('isGarbageText: fewer than 30 word-like tokens is garbage', () => {
  assert.equal(isGarbageText('Arve summa 24,80 EUR'), true)
})
test('isGarbageText: a normal Estonian bill text is usable', () => {
  const bill = 'Elektrum Eesti OÜ arve number 2026-1187 kuupäev 10.11.2026 maksetähtaeg 30.11.2026 viitenumber 1234567 ' +
    'klient Mari Maasikas tarbimiskoht Tamme 5 Tartu elektrienergia november 120 kWh võrguteenus aktsiis taastuvenergia tasu ' +
    'käibemaks 24% arve summa kokku 24,80 EUR tasuda pangalingiga või ülekandega kontole EE382200221020145685'
  assert.equal(isGarbageText(bill), false)
})

// --- vision fallback ---
const noAmount = JSON.stringify({ ...JSON.parse(goodJson), amount: null })
test('garbage PDF text: text model gets no PDF text, vision result is used', async () => {
  const h = harness({ pdfText: GARBAGE, llm: async () => noAmount })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'new')
  assert.equal(h.visions(), 1)
  assert.equal(h.rows.update?.amountCents, 1000)
  assert.equal(h.rows.file, true)
})
test('garbage PDF text and no body: vision alone decides', async () => {
  const h = harness({ pdfText: GARBAGE })
  assert.equal(await processBill(inp({ pdf: PDF, bodyText: '' }), h.store, h.io), 'new')
  assert.equal(h.calls(), 0)
  assert.equal(h.visions(), 1)
})
test('good PDF text but missing dueDate: vision fills it', async () => {
  const h = harness({ llm: async () => JSON.stringify({ ...JSON.parse(goodJson), dueDate: null }) })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'new')
  assert.equal(h.visions(), 1)
  assert.equal(h.rows.update?.dueDate, '2026-12-05')
})
test('good text extraction: vision is not called', async () => {
  const h = harness()
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'new')
  assert.equal(h.visions(), 0)
})
test('text model says not a bill: vision is not called', async () => {
  const h = harness({ llm: async () => JSON.stringify({ ...JSON.parse(goodJson), isBill: false, amount: null }) })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'ignored')
  assert.equal(h.visions(), 0)
})
test('no PDF: vision is never called', async () => {
  const h = harness({ llm: async () => noAmount })
  assert.equal(await processBill(inp(), h.store, h.io), 'review')
  assert.equal(h.visions(), 0)
})
test('vision sees a company payer: bill is ignored as firma arve', async () => {
  const h = harness({ pdfText: GARBAGE, vision: async () => JSON.stringify({ ...JSON.parse(goodJson), billTo: 'Põhja Mööbel OÜ' }) })
  assert.equal(await processBill(inp({ pdf: PDF, bodyText: '' }), h.store, h.io), 'ignored')
  assert.equal(h.rows.update?.ignoreReason, 'firma arve')
})
test('vision failing keeps review, warns with class + static message only', async () => {
  const warns: string[] = []
  const orig = console.warn
  console.warn = (...a: unknown[]) => { warns.push(a.join(' ')) }
  try {
    const h = harness({ pdfText: GARBAGE, llm: async () => noAmount, vision: async () => { throw new Error('gemini 503') } })
    assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'review')
    const h2 = harness({ pdfText: GARBAGE, llm: async () => noAmount, vision: async () => { throw new Error('secret mail text') } })
    assert.equal(await processBill(inp({ pdf: PDF }), h2.store, h2.io), 'review')
  } finally {
    console.warn = orig
  }
  assert.ok(warns.includes('inbound pdf vision failed Error gemini 503'))
  assert.ok(warns.includes('inbound pdf vision failed Error'))
  assert.ok(!warns.some((w) => w.includes('secret')))
})
test('vision returning junk keeps the text result (review)', async () => {
  const h = harness({ llm: async () => noAmount, vision: async () => 'not json' })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'review')
  assert.equal(h.rows.update?.status, 'review')
})
test('daily cap reached: neither text model nor vision is called', async () => {
  const h = harness({ used: DAILY_LLM_CAP, pdfText: GARBAGE })
  assert.equal(await processBill(inp({ pdf: PDF }), h.store, h.io), 'review')
  assert.equal(h.calls() + h.visions(), 0)
})
test('PDF over MAX_PDF_BYTES is never sent to vision', async () => {
  const big = { ...PDF, data: Buffer.alloc(MAX_PDF_BYTES + 1) }
  const h = harness({ pdfText: GARBAGE, llm: async () => noAmount })
  const orig = console.warn
  console.warn = () => {}
  try {
    assert.equal(await processBill(inp({ pdf: big }), h.store, h.io), 'review')
  } finally {
    console.warn = orig
  }
  assert.equal(h.visions(), 0)
})
