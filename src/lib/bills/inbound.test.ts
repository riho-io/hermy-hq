import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processInbound, stripNul, DAILY_LLM_CAP, type InboundStore, type InboundIo, type BillUpdate } from './inbound'

const OWN = 'arved-abc123@inbound.example.test'
const ev = (over: Record<string, unknown> = {}) => ({
  type: 'email.received',
  data: { email_id: 'em_1', from: 'Näidis <noreply@naide.example>', to: [OWN], subject: 'Arve nr 1' , ...over },
})
const goodJson = JSON.stringify({
  isBill: true, confidence: 0.9, supplier: 'Näidis OÜ', amount: 10, currency: 'EUR', dueDate: '2026-12-05',
  reference: null, iban: null, contractNo: null, serviceAddress: 'Näidise 5, Jõhvi', payUrl: null,
})

function harness(over: { llm?: () => Promise<string>; used?: number; claimed?: boolean; pdf?: boolean; pdfText?: string; saveFileThrows?: boolean } = {}) {
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
  const io: InboundIo = {
    fetchEmail: async () => { log.push('fetchEmail'); return { text: 'Tere, arve lisatud.', html: '' } },
    fetchPdf: async () => {
      log.push('fetchPdf')
      return over.pdf ? { filename: 'arve.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4 x') } : null
    },
    pdfToText: async () => { log.push('pdfToText'); return over.pdfText ?? 'PDF tekst' },
    llm: async () => { log.push('llm'); return over.llm ? over.llm() : goodJson },
  }
  return { rows, store, io, log, calls: () => log.filter((c) => c === 'llm').length }
}
const cfg = { ownAddress: OWN }

test('wrong event type is ignored, claim never called', async () => {
  const h = harness()
  assert.equal(await processInbound({ type: 'email.sent', data: {} }, h.store, h.io, cfg), 'ignored_type')
  assert.ok(!h.log.includes('claim'))
})
test('mail to another recipient (e.g. kulu) is ignored, nothing stored, no LLM, no claim', async () => {
  const h = harness()
  assert.equal(await processInbound(ev({ to: ['other@inbound.example.test'] }), h.store, h.io, cfg), 'ignored_recipient')
  assert.equal(h.rows.update, undefined)
  assert.equal(h.calls(), 0)
  assert.ok(!h.log.includes('claim'))
})
test('own address not configured fails closed', async () => {
  const h = harness()
  assert.equal(await processInbound(ev(), h.store, h.io, { ownAddress: undefined }), 'ignored_recipient')
  assert.ok(!h.log.includes('claim'))
})
test('recipient in "Name <addr>" form and different case still matches', async () => {
  const h = harness()
  const out = await processInbound(ev({ to: [`Arved <${OWN.toUpperCase()}>`] }), h.store, h.io, cfg)
  assert.equal(out, 'new')
})
test('received_for has own address, To is another -> processed', async () => {
  const h = harness()
  const out = await processInbound(ev({ received_for: [OWN], to: ['someone-else@x.test'] }), h.store, h.io, cfg)
  assert.equal(out, 'new')
})
test('To has own address, received_for is another -> processed (documented union)', async () => {
  const h = harness()
  const out = await processInbound(ev({ received_for: ['other@inbound.example.test'], to: [OWN] }), h.store, h.io, cfg)
  assert.equal(out, 'new')
})
test('received_for in "Name <addr>" form and different case still matches', async () => {
  const h = harness()
  const out = await processInbound(ev({ received_for: [`Arved <${OWN.toUpperCase()}>`], to: [] }), h.store, h.io, cfg)
  assert.equal(out, 'new')
})
test('neither received_for nor To contains own address -> ignored_recipient, no claim, warn without addresses', async () => {
  const h = harness()
  const warns: unknown[][] = []
  const orig = console.warn
  console.warn = (...a: unknown[]) => { warns.push(a) }
  try {
    const out = await processInbound(ev({ received_for: ['other@inbound.example.test'], to: ['x@y.test'] }), h.store, h.io, cfg)
    assert.equal(out, 'ignored_recipient')
  } finally {
    console.warn = orig
  }
  assert.ok(!h.log.includes('claim'))
  assert.deepEqual(warns, [['inbound ignored: recipient_mismatch']])
})
test('Gmail/Zoho confirmation mail is ignored without LLM and without claim', async () => {
  const h = harness()
  assert.equal(await processInbound(ev({ from: 'Gmail Team <forwarding-noreply@google.com>' }), h.store, h.io, cfg), 'ignored_system')
  assert.equal(h.calls(), 0)
  assert.ok(!h.log.includes('claim'))
})
test('duplicate webhook delivery does nothing: no fetchEmail, no LLM', async () => {
  const h = harness({ claimed: false })
  assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'duplicate')
  assert.deepEqual(h.log, ['claim'])
})
test('claim happens before any fetch or LLM call', async () => {
  const h = harness()
  await processInbound(ev(), h.store, h.io, cfg)
  const c = h.log.indexOf('claim')
  assert.equal(c, 0)
  assert.ok(h.log.indexOf('fetchEmail') > c)
  assert.ok(h.log.indexOf('llm') > c)
})
test('happy path: bill is new, grouped by keyword, PDF saved', async () => {
  const h = harness({ pdf: true })
  assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'new')
  assert.equal(h.rows.update?.status, 'new')
  assert.equal(h.rows.update?.amountCents, 1000)
  assert.equal(h.rows.update?.groupId, 'kodu')
  assert.equal(h.rows.file, true)
})
test('non-bill is ignored and its PDF is NOT stored', async () => {
  const h = harness({ pdf: true, llm: async () => JSON.stringify({ ...JSON.parse(goodJson), isBill: false }) })
  assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'ignored')
  assert.equal(h.rows.update?.status, 'ignored')
  assert.equal(h.rows.file, undefined)
})
test('ignored non-bill stores only status + reason, extracted fields are nulled', async () => {
  const h = harness({
    pdf: true,
    llm: async () => JSON.stringify({
      ...JSON.parse(goodJson), isBill: false, reference: 'R-1', iban: 'EE382200221020145685',
      contractNo: 'L-9', payUrl: 'https://pay.example/x',
    }),
  })
  assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'ignored')
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
  const h = harness({ pdf: true, saveFileThrows: true })
  assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'new')
  assert.equal(h.rows.update?.status, 'new')
})
test('errors are logged by name only, never message', async () => {
  const h = harness({ llm: async () => { throw new Error('secret prisma query context') } })
  const orig = console.error
  const logged: unknown[][] = []
  console.error = (...a: unknown[]) => { logged.push(a) }
  try {
    assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'review')
  } finally {
    console.error = orig
  }
  assert.ok(logged.length > 0)
  assert.ok(!JSON.stringify(logged).includes('secret'))
})
test('LLM garbage leaves a review row (never lost)', async () => {
  const h = harness({ llm: async () => 'sorry I cannot' })
  assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'review')
  assert.equal(h.rows.update, undefined) // claim row already has status review
})
test('LLM throwing leaves a review row (never lost)', async () => {
  const h = harness({ llm: async () => { throw new Error('boom') } })
  assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'review')
})
test('daily cap reached: no LLM call, row stays review', async () => {
  const h = harness({ used: DAILY_LLM_CAP })
  assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'review')
  assert.equal(h.calls(), 0)
})
test('an injected instruction in the email cannot change the schema of the result', async () => {
  const h = harness({ llm: async () => JSON.stringify({ ...JSON.parse(goodJson), status: 'paid', role: 'admin' }) })
  const out = await processInbound(ev(), h.store, h.io, cfg)
  assert.equal(out, 'new')
  assert.equal((h.rows.update as unknown as Record<string, unknown>).role, undefined)
  assert.equal(h.rows.update?.status, 'new')
})

test('pdf present but unreadable (empty text) and LLM says not a bill -> review, PDF saved', async () => {
  const h = harness({ pdf: true, pdfText: '', llm: async () => JSON.stringify({ ...JSON.parse(goodJson), isBill: false }) })
  assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'review')
  assert.equal(h.rows.update?.status, 'review')
  assert.equal(h.rows.file, true)
})
test('pdf with text and LLM says not a bill -> ignored, no file', async () => {
  const h = harness({ pdf: true, pdfText: 'Päris tekst', llm: async () => JSON.stringify({ ...JSON.parse(goodJson), isBill: false }) })
  assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'ignored')
  assert.equal(h.rows.file, undefined)
})
test('pdfToText throwing is logged and does not crash', async () => {
  const h = harness({ pdf: true })
  h.io.pdfToText = async () => { throw new TypeError('x') }
  const warns: unknown[][] = []
  const orig = console.warn
  console.warn = (...a: unknown[]) => { warns.push(a) }
  try {
    await processInbound(ev(), h.store, h.io, cfg)
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
    assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'review')
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
    await processInbound(ev(), h.store, h.io, cfg)
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
  await processInbound(ev({ from: 'a\u0000b <noreply@naide.example>', subject: 'x\u0000y' }), h.store, h.io, cfg)
  assert.ok(got)
  assert.ok(!got.fromAddr.includes('\u0000') && !got.subject.includes('\u0000'))
})
