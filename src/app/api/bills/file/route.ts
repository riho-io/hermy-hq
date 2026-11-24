import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireBillsAccess } from '@/lib/require-session'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { role, denied } = await requireBillsAccess()
  if (denied) return denied
  const id = req.nextUrl.searchParams.get('id')
  if (!id || id.length > 40) return NextResponse.json({ error: 'id puudub' }, { status: 400 })
  // A guest gets only files of bills it can see in GET /api/bills.
  const f = await prisma.billFile.findFirst({
    where: role === 'bills_guest'
      ? { billId: id, bill: { group: { guestVisible: true }, status: { in: ['new', 'paid'] } } }
      : { billId: id },
  })
  if (!f) return NextResponse.json({ error: 'Faili ei ole' }, { status: 404 })
  return new NextResponse(new Uint8Array(f.data), {
    headers: {
      'Content-Type': 'application/pdf',
      // Untrusted (comes from a forwarded email): download, never render inline in our origin.
      'Content-Disposition': 'attachment; filename="arve.pdf"',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, no-store',
    },
  })
}
