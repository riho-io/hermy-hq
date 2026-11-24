import { buildPrompt, decideStatus, parseExtraction, toCents } from './extract'
import { assignGroup, type GroupLite } from './group'

// Each bill row allows one text extraction plus at most one PDF vision call, both behind this cap.
export const DAILY_LLM_CAP = 60
/** Largest PDF accepted from ingest and sent to the vision model. */
export const MAX_PDF_BYTES = 3 * 1024 * 1024

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
  /** True when another bill (new/review/paid) has the same supplier (case-insensitive), amount and due date. */
  findDuplicate(m: { excludeId: string; supplier: string; amountCents: number; dueDate: string }): Promise<boolean>
}
export interface BillIo {
  pdfToText(data: Buffer): Promise<string>
  llm(p: { system: string; user: string }): Promise<string>
  /** Reads the PDF itself (scans, broken text layer) with the same prompt; returns the raw JSON reply. */
  pdfVision(data: Buffer, p: { system: string; user: string }): Promise<string>
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
const STATIC_MSG = /^(deepseek \d{3}|DEEPSEEK_API_KEY missing|gemini \d{3}|gemini empty|GEMINI_API_KEY missing|pdf too large)$/
const staticMsg = (err: unknown) => (err instanceof Error && STATIC_MSG.test(err.message) ? ` ${err.message}` : '')

/**
 * True when extracted PDF text is unusable: empty, mostly symbols (broken font mapping like `!" ""#"$! % &'`),
 * or too few word-like tokens to hold a bill.
 */
export function isGarbageText(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  const good = (t.match(/[\p{L}\p{N}\s]/gu) ?? []).length
  if (good / t.length < 0.6) return true
  return (t.match(/[\p{L}\p{N}]{2,}/gu) ?? []).length < 30
}

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
    // Garbage glyphs only waste tokens and confuse the text model: drop them and let vision read the PDF.
    if (pdf && isGarbageText(pdfText)) pdfText = ''
    const bodyText = input.bodyText
    if (!bodyText && !pdfText && !pdf) return 'review'

    let e: ReturnType<typeof parseExtraction> = null
    if (bodyText || pdfText) {
      step = 'llm'
      const raw = await io.llm(buildPrompt({ from, subject, bodyText, pdfText }))
      step = 'parse'
      e = parseExtraction(raw)
    }

    // Vision fallback: the PDF text was unusable, or the text model could not find the amount or due date of a bill.
    let usedVision = false
    if (pdf && (!pdfText || !e || (e.isBill && (e.amount === null || e.dueDate === null)))) {
      step = 'vision'
      try {
        if (pdf.data.length > MAX_PDF_BYTES) throw new Error('pdf too large')
        const v = parseExtraction(
          await io.pdfVision(pdf.data, buildPrompt({ from, subject, bodyText, pdfText: '(see the attached PDF file)' })),
        )
        if (v) {
          e = v
          usedVision = true
        } else {
          console.warn('inbound pdf vision unparsable')
        }
      } catch (err) {
        // Bill stays in review; log the class and static adapter message only, never mail content.
        console.warn(`inbound pdf vision failed ${errTag(err)}${staticMsg(err)}`)
      }
    }
    if (!e) return 'review'

    step = 'store_update'
    let decision = decideStatus(e)
    // A scanned/unreadable PDF must never hide a real bill under "ignored": send it to review and keep the file.
    // A vision verdict has seen the PDF itself, so it may ignore (e.g. a company payer).
    if (decision.status === 'ignored' && pdf && !pdfText.trim() && !usedVision) decision = { status: 'review', reason: null }
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
    // Several reminder mails for the same bill: same supplier + amount + due date = same bill.
    const amountCents = toCents(e.amount)
    const supplier = e.supplier?.trim()
    if (supplier && amountCents !== null && e.dueDate) {
      step = 'dedupe'
      let isDuplicate = false
      try {
        isDuplicate = await store.findDuplicate({ excludeId: id, supplier, amountCents, dueDate: e.dueDate })
      } catch (err) {
        // A failed lookup must not lose the bill: log and treat it as a new bill.
        console.error(`inbound bill failed step=${step} ${errTag(err)}`)
      }
      step = 'store_update'
      if (isDuplicate) {
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
          ignoreReason: 'duplikaat',
        })
        return 'ignored'
      }
    }
    const groupId = assignGroup([e.serviceAddress, e.supplier, e.contractNo, subject], await store.groups())
    await store.update(id, {
      status: decision.status,
      supplier: e.supplier,
      amountCents,
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
    console.error(`inbound bill failed step=${step} ${errTag(err)}${staticMsg(err)}`)
    return 'review'
  }
}
