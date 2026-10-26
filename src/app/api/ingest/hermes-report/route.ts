import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasIngestSecret } from '@/lib/internal-secret';

// Argo's hermy_cron_sync.py pushes the report text of cron runs it was told to share (allowlist lives on Argo).
// Write-only for Argo; the /raportid page reads via Prisma. A re-push of the same run is an upsert.

const MAX_BODY_BYTES = 2_000_000;
const MAX_REPORT_CHARS = 100_000;
const REPORT_RETENTION_DAYS = 400;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const Report = z.object({
  jobId: id,
  // Output file stem, e.g. "2026-10-26_10-05-38"; together with jobId it is the row id.
  run: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}$/),
  jobName: z.string().min(1).max(20_000).transform((s) => s.slice(0, 200)),
  runAt: z
    .string()
    .max(40)
    .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp')
    .transform((s) => new Date(s)),
  // Over-long reports are clipped, not rejected, so one runaway report can't block the rest.
  body: z.string().min(1).max(MAX_BODY_BYTES).transform((s) => s.slice(0, MAX_REPORT_CHARS)),
});

const Payload = z.object({
  source: z.enum(['argo']),
  reports: z.array(Report).max(50),
});

export async function POST(req: NextRequest) {
  if (!hasIngestSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = Payload.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', issues: parsed.error.issues.slice(0, 10) }, { status: 400 });
  }
  const { source, reports } = parsed.data;
  const now = new Date();

  try {
    await prisma.$transaction([
      ...reports.map(({ run, ...r }) => {
        const row = { ...r, source, syncedAt: now };
        return prisma.agentReport.upsert({
          where: { id: `${r.jobId}/${run}` },
          create: { id: `${r.jobId}/${run}`, ...row },
          update: row,
        });
      }),
      prisma.agentReport.deleteMany({
        where: { source, runAt: { lt: new Date(now.getTime() - REPORT_RETENTION_DAYS * 86_400_000) } },
      }),
    ]);
  } catch (err) {
    // Details go to the server log only; the caller gets no DB internals.
    console.error('ingest/hermes-report failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Write failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, reports: reports.length });
}
