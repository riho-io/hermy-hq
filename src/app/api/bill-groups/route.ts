import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/require-session'
import { GroupPatchSchema, GroupSchema } from '@/lib/bills/validate'

export const dynamic = 'force-dynamic'

export async function GET() {
  const denied = await requireSession()
  if (denied) return denied
  const groups = await prisma.billGroup.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })
  return NextResponse.json({ groups })
}

export async function POST(req: NextRequest) {
  const denied = await requireSession()
  if (denied) return denied
  const parsed = GroupSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Vigane sisend' }, { status: 400 })
  const g = parsed.data
  const group = await prisma.billGroup.create({
    data: { name: g.name, address: g.address ?? null, keywords: g.keywords, sortOrder: g.sortOrder ?? 0 },
  })
  return NextResponse.json({ group }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const denied = await requireSession()
  if (denied) return denied
  const parsed = GroupPatchSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Vigane sisend' }, { status: 400 })
  const { id, ...rest } = parsed.data
  const n = await prisma.billGroup.updateMany({
    where: { id },
    data: {
      ...(rest.name !== undefined && { name: rest.name }),
      ...(rest.address !== undefined && { address: rest.address }),
      ...(rest.keywords !== undefined && { keywords: rest.keywords }),
      ...(rest.sortOrder !== undefined && { sortOrder: rest.sortOrder }),
    },
  })
  if (n.count === 0) return NextResponse.json({ error: 'Plokki ei leitud' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const denied = await requireSession()
  if (denied) return denied
  const id = req.nextUrl.searchParams.get('id')
  if (!id || id.length > 40) return NextResponse.json({ error: 'id puudub' }, { status: 400 })
  // Bills of a deleted block fall back to "Sorteerimata" (FK on delete set null).
  await prisma.billGroup.deleteMany({ where: { id } })
  return NextResponse.json({ ok: true })
}
