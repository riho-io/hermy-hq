import { buildPrompt, decideStatus, parseExtraction, toCents } from './extract'
import { assignGroup, type GroupLite } from './group'

export const DAILY_LLM_CAP = 60

export type Outcome = 'duplicate' | 'review' | 'new' | 'ignored'
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
export interface BillIo {
  pdfToText(data: Buffer): Promise<string>
  llm(p: { system: string; user: string }): Promise<string>
}
export type BillInput = {
  messageKey: string
  from: string
  subject: string
  account: 'gmail' | 'youtb' | 'zoho-isiklik'
  bodyText: string
  pdf: PdfFile | null
}

export const stripNul = (s: string) => s.replace(/\u0000/g, '')
// Log only the error class (and Prisma-style code): messages can carry query context or mail content.
const errTag = (err: unknown) => {
  if (!(err instanceof Error)) return 'unknown'
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? `${err.name} ${code}` : err.name
}

// Adapter messages matching this are static and carry no mail content; nothing else is logged.
const STATIC_MSG = /^(deepseek \d{3}|DEEPSEEK_API_KEY missing)$/

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

export async function processBill(input: BillInput, store: InboundStore, io: BillIo): Promise<Outcome> {
  const { from, subject, pdf } = input
  const id = await store.claim({
    emailId: 'imap:' + input.messageKey,
    fromAddr: stripNul(from).slice(0, 200),
    subject: stripNul(subject).slice(0, 300),
  })
  if (!id) return 'duplicate'

  // From here the row exists with status "review": any failure leaves it visible instead of losing the bill.
  let step = 'start'
  try {
    // Count includes the row just claimed, so >= keeps real LLM calls at most DAILY_LLM_CAP - 1 per 24 h (fail-safe side).
    if ((await store.extractionsLast24h()) >= DAILY_LLM_CAP) return 'review'
    step = 'pdf_text'
    let pdfText = ''
    if (pdf) {
      try {
        pdfText = await io.pdfToText(pdf.data)
      } catch (err) {
        console.warn('inbound pdf text failed', errTag(err))
      }
    }
    const bodyText = input.bodyText
    if (!bodyText && !pdfText) return 'review'

    step = 'llm'
    const raw = await io.llm(buildPrompt({ from, subject, bodyText, pdfText }))
    step = 'parse'
    const e = parseExtraction(raw)
    if (!e) return 'review'

    step = 'store_update'
    let decision = decideStatus(e)
    // A scanned/unreadable PDF must never hide a real bill under "ignored": send it to review and keep the file.
    if (decision.status === 'ignored' && pdf && !pdfText.trim()) decision = { status: 'review', reason: null }
    if (decision.status === 'ignored') {
      // Not a bill: keep only the verdict, none of the extracted personal data.
      await store.update(id, {
        status: 'ignored',
        supplier: null,
        amountCents: null,
        currency: 'EUR',
        dueDate: null,
        reference: null,
        iban: null,
        contractNo: null,
        serviceAddress: null,
        payUrl: null,
        groupId: null,
        ignoreReason: decision.reason,
      })
      return 'ignored'
    }
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
    if (pdf) {
      // The bill row is already saved; a failed PDF write must not turn it back into "review".
      try {
        await store.saveFile(id, pdf)
      } catch (err) {
        console.error('inbound pdf save failed', errTag(err))
      }
    }
    return decision.status
  } catch (err) {
    const msg = err instanceof Error && STATIC_MSG.test(err.message) ? ` ${err.message}` : ''
    console.error(`inbound bill failed step=${step} ${errTag(err)}${msg}`)
    return 'review'
  }
}
