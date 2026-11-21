import { z } from 'zod'
import { buildPrompt, decideStatus, parseExtraction, toCents } from './extract'
import { assignGroup, type GroupLite } from './group'

export const DAILY_LLM_CAP = 60
const SYSTEM_SENDERS = ['forwarding-noreply@google.com', 'noreply@zoho.eu', 'noreply@zoho.com']

export type Outcome = 'ignored_type' | 'ignored_recipient' | 'ignored_system' | 'duplicate' | 'review' | 'new' | 'ignored'
export type PdfFile = { filename: string; contentType: 'application/pdf'; data: Buffer }
export type BillUpdate = {
  status: 'new' | 'review' | 'ignored'
  supplier: string | null
  amountCents: number | null
  currency: string
  dueDate: string | null
  reference: string | null
  iban: string | null
  contractNo: string | null
  serviceAddress: string | null
  payUrl: string | null
  groupId: string | null
  ignoreReason: string | null
}
export interface InboundStore {
  claim(m: { emailId: string; fromAddr: string; subject: string }): Promise<string | null>
  update(id: string, patch: BillUpdate): Promise<void>
  saveFile(id: string, f: PdfFile): Promise<void>
  groups(): Promise<GroupLite[]>
  extractionsLast24h(): Promise<number>
}
export interface InboundIo {
  fetchEmail(emailId: string): Promise<{ text: string; html: string }>
  fetchPdf(emailId: string): Promise<PdfFile | null>
  pdfToText(data: Buffer): Promise<string>
  llm(p: { system: string; user: string }): Promise<string>
}

const EventSchema = z.object({
  type: z.string(),
  data: z.object({
    email_id: z.string().min(1).max(100),
    from: z.string().max(500).default(''),
    to: z.array(z.string().max(500)).max(50).default([]),
    subject: z.string().max(1000).default(''),
  }),
})

const addrOf = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase()

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function processInbound(
  event: unknown,
  store: InboundStore,
  io: InboundIo,
  cfg: { ownAddress: string | undefined },
): Promise<Outcome> {
  const parsed = EventSchema.safeParse(event)
  if (!parsed.success || parsed.data.type !== 'email.received') return 'ignored_type'
  const { email_id, from, to, subject } = parsed.data.data

  // Identify by recipient (the sender is forgeable). The same Resend domain also serves other apps (kulu).
  const own = cfg.ownAddress?.trim().toLowerCase()
  if (!own || !to.some((t) => addrOf(t) === own)) return 'ignored_recipient'
  if (SYSTEM_SENDERS.includes(addrOf(from))) return 'ignored_system'

  const id = await store.claim({ emailId: email_id, fromAddr: from.slice(0, 200), subject: subject.slice(0, 300) })
  if (!id) return 'duplicate'

  // From here the row exists with status "review": any failure leaves it visible instead of losing the bill.
  try {
    // Count includes the row just claimed, so >= keeps real LLM calls at most DAILY_LLM_CAP - 1 per 24 h (fail-safe side).
    if ((await store.extractionsLast24h()) >= DAILY_LLM_CAP) return 'review'
    const email = await io.fetchEmail(email_id)
    const pdf = await io.fetchPdf(email_id)
    const pdfText = pdf ? await io.pdfToText(pdf.data).catch(() => '') : ''
    const bodyText = email.text || stripHtml(email.html)
    if (!bodyText && !pdfText) return 'review'

    const raw = await io.llm(buildPrompt({ from, subject, bodyText, pdfText }))
    const e = parseExtraction(raw)
    if (!e) return 'review'

    const decision = decideStatus(e)
    const groupId = assignGroup([e.serviceAddress, e.supplier, e.contractNo, subject], await store.groups())
    await store.update(id, {
      status: decision.status,
      supplier: e.supplier,
      amountCents: toCents(e.amount),
      currency: e.currency ?? 'EUR',
      dueDate: e.dueDate,
      reference: e.reference,
      iban: e.iban,
      contractNo: e.contractNo,
      serviceAddress: e.serviceAddress,
      payUrl: e.payUrl,
      groupId,
      ignoreReason: decision.reason,
    })
    if (pdf && decision.status !== 'ignored') await store.saveFile(id, pdf)
    return decision.status
  } catch (err) {
    console.error('inbound bill failed', err instanceof Error ? err.message : 'unknown')
    return 'review'
  }
}
