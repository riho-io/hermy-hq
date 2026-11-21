import { NextResponse } from 'next/server'
import { z } from 'zod'
import { hasIngestSecret } from '@/lib/internal-secret'
import { processBill } from '@/lib/bills/inbound'
import { io, store } from '@/lib/bills/adapters'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
const MAX_BYTES = 4_400_000
const MAX_PDF = 3 * 1024 * 1024

const Body = z.object({
  messageKey: z.string().regex(/^[a-f0-9]{64}$/),
  from: z.string().max(500),
  subject: z.string().max(1000),
  account: z.enum(['gmail', 'youtb', 'zoho-isiklik']),
  bodyText: z.string().max(20_000),
  pdf: z.object({ filename: z.string().min(1).max(200), base64: z.string().max(4_200_000) }).nullable(),
})

const errTag = (err: unknown) => (err instanceof Error ? err.name : 'unknown')

// Argo (argo_arved.py) pushes one personal bill candidate per call. Auth = x-ingest-secret only.
export async function POST(req: Request) {
  if (!hasIngestSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const raw = await req.text()
  if (Buffer.byteLength(raw) > MAX_BYTES) return NextResponse.json({ error: 'Too large' }, { status: 413 })
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }
  const parsed = Body.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  const b = parsed.data
  let pdf = null
  if (b.pdf) {
    const data = Buffer.from(b.pdf.base64, 'base64')
    if (data.length > 0 && data.length <= MAX_PDF && data.subarray(0, 5).toString('latin1') === '%PDF-') {
      pdf = { filename: b.pdf.filename, contentType: 'application/pdf' as const, data }
    } else {
      console.warn('ingest/bills pdf skipped: not_pdf_or_size')
    }
  }
  try {
    const outcome = await processBill(
      { messageKey: b.messageKey, from: b.from, subject: b.subject, account: b.account, bodyText: b.bodyText, pdf },
      store,
      io,
    )
    return NextResponse.json({ ok: true, outcome })
  } catch (err) {
    console.error('ingest/bills failed', errTag(err))
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
