import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/require-session'
import { bannerIssues, parseArgoHealth } from '@/lib/argo-health'

export const dynamic = 'force-dynamic'
const FAIL_STREAK = 3

export async function GET() {
  const denied = await requireSession()
  if (denied) return denied
  try {
    const [row, jobs] = await Promise.all([
      prisma.kontoCheck.findUnique({ where: { id: 'argo-health' } }),
      prisma.agentJob.findMany({
        where: { enabled: true, failureStreak: { gte: FAIL_STREAK } },
        select: { name: true },
        orderBy: { name: 'asc' },
      }),
    ])
    const health = row ? parseArgoHealth(row.payload) : null
    return NextResponse.json(
      { issues: bannerIssues(health, new Date(), jobs.map((j) => j.name)) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (err) {
    console.error('argo-health read failed:', err instanceof Error ? err.message : 'unknown')
    return NextResponse.json({ error: 'Read failed' }, { status: 500 })
  }
}
