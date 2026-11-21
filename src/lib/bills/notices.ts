export function tallinnToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Tallinn', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000)
}

export type NoticeInput = {
  id: string
  status: string
  dueDate: string | null
  remind3SentAt: Date | null
  remindDueSentAt: Date | null
}
export type Notice = { id: string; kind: 'd3' | 'due'; daysLeft: number }

/** d3: 1..3 days before the deadline; due: on the deadline or later (first time only). Each kind at most once. */
export function dueNotices(bills: NoticeInput[], today: string): Notice[] {
  const out: Notice[] = []
  for (const b of bills) {
    if ((b.status !== 'new' && b.status !== 'review') || !b.dueDate) continue
    const daysLeft = daysBetween(today, b.dueDate)
    if (daysLeft <= 0) {
      if (!b.remindDueSentAt) out.push({ id: b.id, kind: 'due', daysLeft })
    } else if (daysLeft <= 3) {
      if (!b.remind3SentAt) out.push({ id: b.id, kind: 'd3', daysLeft })
    }
  }
  return out
}
