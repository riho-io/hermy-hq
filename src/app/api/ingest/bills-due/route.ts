import { NextResponse } from 'next/server'
import { hasIngestSecret } from '@/lib/internal-secret'
import { prisma } from '@/lib/prisma'
import { dueNotices, tallinnToday } from '@/lib/bills/notices'

export const dynamic = 'force-dynamic'

const eur = (c: number | null, cur: string) =>
  c === null ? 'summa teadmata' : `${(c / 100).toFixed(2).replace('.', ',')} ${cur === 'EUR' ? '€' : cur}`

// Argo (hermy_bills_tg.py) pulls what needs a Telegram message TODAY. The decision lives here (testable, Tallinn date);
// the script only sends and then acknowledges through /api/ingest/bills-notified.
export async function GET(req: Request) {
  if (!hasIngestSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const today = tallinnToday()
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 3 * 86_400_000)
  try {
    const rows = await prisma.bill.findMany({
      where: { status: { in: ['new', 'review'] }, dueDate: { not: null, lte: horizon } },
      include: { group: { select: { name: true } } },
    })
    const byId = new Map(rows.map((r) => [r.id, r]))
    const notices = dueNotices(
      rows.map((r) => ({
        id: r.id, status: r.status, dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null,
        remind3SentAt: r.remind3SentAt, remindDueSentAt: r.remindDueSentAt,
      })),
      today,
    )
    const items = notices.map((n) => {
      const r = byId.get(n.id)!
      return {
        id: n.id, kind: n.kind, daysLeft: n.daysLeft,
        supplier: r.supplier ?? r.subject ?? '(nimeta)', amount: eur(r.amountCents, r.currency),
        dueDate: r.dueDate!.toISOString().slice(0, 10), group: r.group?.name ?? 'Sorteerimata',
        reference: r.reference, iban: r.iban, payUrl: r.payUrl,
      }
    })
    return NextResponse.json({ today, items })
  } catch (err) {
    // Name/code only: err.message can carry row data or connection details.
    const code = (err as { code?: unknown } | null)?.code
    console.error('ingest/bills-due failed', err instanceof Error ? err.name : 'unknown', typeof code === 'string' ? code : '')
    return NextResponse.json({ error: 'Read failed' }, { status: 500 })
  }
}
