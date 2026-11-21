import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processInbound, DAILY_LLM_CAP, type InboundStore, type InboundIo, type BillUpdate } from './inbound'

const OWN = 'arved-abc123@inbound.example.test'
const ev = (over: Record<string, unknown> = {}) => ({
  type: 'email.received',
  data: { email_id: 'em_1', from: 'Näidis <noreply@naide.example>', to: [OWN], subject: 'Arve nr 1' , ...over },
})
const goodJson = JSON.stringify({
  isBill: true, confidence: 0.9, supplier: 'Näidis OÜ', amount: 10, currency: 'EUR', dueDate: '2026-12-05',
  reference: null, iban: null, contractNo: null, serviceAddress: 'Näidise 5, Jõhvi', payUrl: null,
})

function harness(over: { llm?: () => Promise<string>; used?: number; claimed?: boolean; pdf?: boolean } = {}) {
  const rows: { id: string; update?: BillUpdate; file?: boolean } = { id: 'bill_1' }
  let llmCalls = 0
  const store: InboundStore = {
    claim: async () => (over.claimed === false ? null : 'bill_1'),
    update: async (_id, patch) => { rows.update = patch },
    saveFile: async () => { rows.file = true },
    groups: async () => [{ id: 'kodu', keywords: ['Näidise 5'], sortOrder: 0 }],
    extractionsLast24h: async () => over.used ?? 1,
  }
  const io: InboundIo = {
    fetchEmail: async () => ({ text: 'Tere, arve lisatud.', html: '' }),
    fetchPdf: async () => (over.pdf ? { filename: 'arve.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4 x') } : null),
    pdfToText: async () => 'PDF tekst',
    llm: async () => { llmCalls++; return over.llm ? over.llm() : goodJson },
  }
  return { rows, store, io, calls: () => llmCalls }
}
const cfg = { ownAddress: OWN }

test('wrong event type is ignored', async () => {
  const h = harness()
  assert.equal(await processInbound({ type: 'email.sent', data: {} }, h.store, h.io, cfg), 'ignored_type')
})
test('mail to another recipient (e.g. kulu) is ignored, nothing stored, no LLM', async () => {
  const h = harness()
  assert.equal(await processInbound(ev({ to: ['other@inbound.example.test'] }), h.store, h.io, cfg), 'ignored_recipient')
  assert.equal(h.rows.update, undefined)
  assert.equal(h.calls(), 0)
})
test('own address not configured fails closed', async () => {
  const h = harness()
  assert.equal(await processInbound(ev(), h.store, h.io, { ownAddress: undefined }), 'ignored_recipient')
})
test('recipient in "Name <addr>" form and different case still matches', async () => {
  const h = harness()
  const out = await processInbound(ev({ to: [`Arved <${OWN.toUpperCase()}>`] }), h.store, h.io, cfg)
  assert.equal(out, 'new')
})
test('Gmail/Zoho confirmation mail is ignored without LLM', async () => {
  const h = harness()
  assert.equal(await processInbound(ev({ from: 'Gmail Team <forwarding-noreply@google.com>' }), h.store, h.io, cfg), 'ignored_system')
  assert.equal(h.calls(), 0)
})
test('duplicate webhook delivery does nothing', async () => {
  const h = harness({ claimed: false })
  assert.equal(await processInbound(ev(), h.store, h.io, cfg), 'duplicate')
  assert.equal(h.calls(), 0)
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
