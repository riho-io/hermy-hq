import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/require-session'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const denied = await requireSession()
  if (denied) return denied
  const id = req.nextUrl.searchParams.get('id')
  if (!id || id.length > 40) return NextResponse.json({ error: 'id puudub' }, { status: 400 })
  const f = await prisma.billFile.findUnique({ where: { billId: id } })
  if (!f) return NextResponse.json({ error: 'Faili ei ole' }, { status: 404 })
  return new NextResponse(new Uint8Array(f.data), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="arve.pdf"',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'private, no-store',
    },
  })
}
