import { z } from 'zod'

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'invalid date')
const text = (n: number) => z.string().trim().max(n)
const optText = (n: number) => text(n).transform((s) => (s.length ? s : null)).nullable().optional()
const euros = z.number().min(0).max(1_000_000)
const httpsUrl = z
  .string()
  .max(500)
  .refine((u) => {
    try {
      return new URL(u).protocol === 'https:'
    } catch {
      return false
    }
  }, 'https only')

export const ManualBillSchema = z.strictObject({
  supplier: text(120).min(1),
  amount: euros.nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  dueDate: date.nullable().optional(),
  groupId: z.string().max(40).nullable().optional(),
  reference: optText(60),
  iban: optText(40),
  contractNo: optText(60),
  serviceAddress: optText(200),
  payUrl: httpsUrl.nullable().optional(),
  notes: optText(1000),
})

export const BillPatchSchema = z.strictObject({
  id: z.string().min(1).max(40),
  supplier: text(120).min(1).optional(),
  amount: euros.nullable().optional(),
  dueDate: date.nullable().optional(),
  groupId: z.string().max(40).nullable().optional(),
  status: z.enum(['new', 'review', 'paid', 'ignored']).optional(),
  reference: optText(60),
  iban: optText(40),
  contractNo: optText(60),
  serviceAddress: optText(200),
  payUrl: httpsUrl.nullable().optional(),
  notes: optText(1000),
})

const keyword = z.string().trim().min(3).max(40)
export const GroupSchema = z.strictObject({
  name: text(80).min(1),
  address: optText(200),
  keywords: z.array(keyword).max(20).default([]),
  sortOrder: z.number().int().min(0).max(1000).optional(),
})
export const GroupPatchSchema = GroupSchema.partial().extend({ id: z.string().min(1).max(40) })

export function eurosToCents(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100)
}

/** Turns a validated patch into a Prisma update; only touched fields appear. */
export function patchToData(p: z.infer<typeof BillPatchSchema>, now: Date = new Date()): Record<string, unknown> {
  const d: Record<string, unknown> = {}
  const copy = ['supplier', 'groupId', 'reference', 'iban', 'contractNo', 'serviceAddress', 'payUrl', 'notes'] as const
  for (const k of copy) if (p[k] !== undefined) d[k] = p[k]
  if (p.amount !== undefined) d.amountCents = eurosToCents(p.amount)
  if (p.dueDate !== undefined) {
    d.dueDate = p.dueDate === null ? null : new Date(`${p.dueDate}T00:00:00Z`)
    // A new deadline must be able to notify again.
    d.remind3SentAt = null
    d.remindDueSentAt = null
  }
  if (p.status !== undefined) {
    d.status = p.status
    d.paidAt = p.status === 'paid' ? now : null
  }
  return d
}
