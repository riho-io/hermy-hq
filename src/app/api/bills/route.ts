import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireBillsAccess, requireSession } from '@/lib/require-session'
import { BillPatchSchema, BillRestoreSchema, GuestBillPatchSchema, ManualBillSchema, dropUnchanged, eurosToCents, patchToData } from '@/lib/bills/validate'

export const dynamic = 'force-dynamic'

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

// Log only the error class and Prisma code, never the message (it can contain row data).
function logErr(where: string, e: unknown) {
  const name = e instanceof Error ? e.name : 'unknown'
  const code = typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : ''
  console.error(where, name, code)
}

export async function GET() {
  const { role, denied } = await requireBillsAccess()
  if (denied) return denied
  const guest = role === 'bills_guest'
  // A guest sees only open/paid bills of blocks the owner marked guestVisible; never review/ignored or unsorted.
  const [bills, groups] = await Promise.all([
    prisma.bill.findMany({
      where: guest ? { group: { guestVisible: true }, status: { in: ['new', 'paid'] }, deletedAt: null } : undefined,
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: {
        id: true, groupId: true, source: true, status: true, supplier: true, amountCents: true, currency: true,
        dueDate: true, reference: true, iban: true, contractNo: true, serviceAddress: true, payUrl: true,
        notes: !guest, subject: true, ignoreReason: !guest, paidAt: true, createdAt: true, deletedAt: true, file: { select: { billId: true } },
      },
    }),
    prisma.billGroup.findMany({
      where: guest ? { guestVisible: true } : undefined,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, address: true, keywords: !guest, sortOrder: true, guestVisible: true },
    }),
  ])
  return NextResponse.json({
    role,
    bills: bills.map(({ file, dueDate, ...b }) => ({ ...b, dueDate: iso(dueDate), hasFile: !!file })),
    groups,
  })
}

export async function POST(req: NextRequest) {
  const denied = await requireSession()
  if (denied) return denied
  const parsed = ManualBillSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Vigane sisend' }, { status: 400 })
  const b = parsed.data
  try {
    const bill = await prisma.bill.create({
      data: {
        source: 'manual', status: 'new', supplier: b.supplier,
        amountCents: eurosToCents(b.amount ?? null), currency: b.currency ?? 'EUR',
        dueDate: b.dueDate ? new Date(`${b.dueDate}T00:00:00Z`) : null,
        groupId: b.groupId ?? null, reference: b.reference ?? null, iban: b.iban ?? null,
        contractNo: b.contractNo ?? null, serviceAddress: b.serviceAddress ?? null,
        payUrl: b.payUrl ?? null, notes: b.notes ?? null,
      },
      select: { id: true },
    })
    return NextResponse.json({ bill }, { status: 201 })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003')
      return NextResponse.json({ error: 'Plokki ei ole' }, { status: 400 })
    logErr('bills POST failed', e)
    return NextResponse.json({ error: 'Salvestamine ebaõnnestus' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const { role, denied } = await requireBillsAccess()
  if (denied) return denied
  const body = await req.json().catch(() => null)
  if (role === 'bills_guest') {
    // Guest: only {id, status:'paid'}, only an open bill in a guestVisible block. Precondition sits in the WHERE.
    const g = GuestBillPatchSchema.safeParse(body)
    if (!g.success) return NextResponse.json({ error: 'Vigane sisend' }, { status: 400 })
    const n = await prisma.bill.updateMany({
      where: { id: g.data.id, status: 'new', deletedAt: null, group: { guestVisible: true } },
      data: { status: 'paid', paidAt: new Date() },
    })
    if (n.count === 0) return NextResponse.json({ error: 'Arvet ei leitud või juba makstud' }, { status: 404 })
    return NextResponse.json({ ok: true })
  }
  const restore = BillRestoreSchema.safeParse(body)
  if (restore.success) {
    try {
      const n = await prisma.bill.updateMany({ where: { id: restore.data.id, deletedAt: { not: null } }, data: { deletedAt: null } })
      if (n.count === 0) return NextResponse.json({ error: 'Arvet ei leitud või juba taastatud' }, { status: 404 })
      return NextResponse.json({ ok: true })
    } catch (e) {
      logErr('bills restore failed', e)
      return NextResponse.json({ error: 'Taastamine ebaõnnestus' }, { status: 500 })
    }
  }
  const parsed = BillPatchSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Vigane sisend' }, { status: 400 })
  try {
    const existing = await prisma.bill.findUnique({
      where: { id: parsed.data.id },
      select: { dueDate: true, status: true },
    })
    if (!existing) return NextResponse.json({ error: 'Arvet või plokki ei leitud' }, { status: 404 })
    const patch = dropUnchanged(parsed.data, { dueDate: iso(existing.dueDate), status: existing.status })
    await prisma.bill.update({ where: { id: patch.id }, data: patchToData(patch) as Prisma.BillUpdateInput })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2025' || e.code === 'P2003'))
      return NextResponse.json({ error: 'Arvet või plokki ei leitud' }, { status: 404 })
    logErr('bills PATCH failed', e)
    return NextResponse.json({ error: 'Salvestamine ebaõnnestus' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await requireSession()
  if (denied) return denied
  const id = req.nextUrl.searchParams.get('id')
  if (!id || id.length > 40) return NextResponse.json({ error: 'id puudub' }, { status: 400 })
  // Soft delete, so a wrong click can be undone. The row also keeps its emailId, so the mail is not imported again.
  await prisma.bill.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } })
  return NextResponse.json({ ok: true })
}
