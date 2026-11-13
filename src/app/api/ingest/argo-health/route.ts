import { NextResponse } from 'next/server'
import { hasIngestSecret } from '@/lib/internal-secret'
import { parseArgoHealth } from '@/lib/argo-health'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'
const MAX_BYTES = 10_000

export async function POST(req: Request) {
  if (!hasIngestSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const text = await req.text()
  if (text.length > MAX_BYTES) {
    return NextResponse.json({ error: 'Too large' }, { status: 413 })
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }
  const health = parseArgoHealth(json)
  if (!health) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }
  const checkedAt = new Date(health.checkedAt)
  await prisma.kontoCheck.upsert({
    where: { id: 'argo-health' },
    create: { id: 'argo-health', payload: health, checkedAt },
    update: { payload: health, checkedAt },
  })
  return NextResponse.json({ ok: true })
}
