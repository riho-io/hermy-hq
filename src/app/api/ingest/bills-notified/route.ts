import { NextResponse } from 'next/server'
import { z } from 'zod'
import { hasIngestSecret } from '@/lib/internal-secret'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'
const MAX_BYTES = 20_000

const Body = z.object({
  ack: z.array(z.object({ id: z.string().min(1).max(40), kind: z.enum(['d3', 'due']) })).max(100),
})

export async function POST(req: Request) {
  if (!hasIngestSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const raw = await req.text()
  if (raw.length > MAX_BYTES) return NextResponse.json({ error: 'Too large' }, { status: 413 })
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }
  const parsed = Body.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  const now = new Date()
  let marked = 0
  try {
    for (const a of parsed.data.ack) {
      // Precondition in the WHERE: a second ack marks nothing. An ack for a bill whose deadline was edited between read and ack still
      // marks it as sent; the window is seconds once a day, accepted.
      const r =
        a.kind === 'd3'
          ? await prisma.bill.updateMany({ where: { id: a.id, remind3SentAt: null }, data: { remind3SentAt: now } })
          : await prisma.bill.updateMany({ where: { id: a.id, remindDueSentAt: null }, data: { remindDueSentAt: now } })
      marked += r.count
    }
  } catch (err) {
    // Name/code only: err.message can carry row data or connection details.
    const code = (err as { code?: unknown } | null)?.code
    console.error('ingest/bills-notified failed', err instanceof Error ? err.name : 'unknown', typeof code === 'string' ? code : '')
    return NextResponse.json({ error: 'Write failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, marked })
}
