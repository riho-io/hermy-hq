import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-konto-secret');
  if (!secret || secret !== process.env.KONTO_PUSH_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const payload = await req.json();

  await prisma.kontoCheck.upsert({
    where: { id: 'latest' },
    create: { id: 'latest', payload, checkedAt: new Date() },
    update: { payload, checkedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  const row = await prisma.kontoCheck.findUnique({ where: { id: 'latest' } });
  if (!row) {
    return NextResponse.json({ checked_at: null, checks: [], problems_count: 0 });
  }
  const payload = row.payload as { checks?: unknown[]; problems_count?: number };
  return NextResponse.json({
    checked_at: row.checkedAt.toISOString(),
    checks: payload.checks ?? [],
    problems_count: payload.problems_count ?? 0,
  });
}
