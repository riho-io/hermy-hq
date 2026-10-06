import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasIngestSecret } from '@/lib/internal-secret';

// Argo's hermy_cron_sync.py pushes a snapshot of ~/.hermes/cron/jobs.json plus the
// executions that changed since its last push. Write-only for Argo; the dashboard reads via Prisma.

const MAX_BODY_BYTES = 1_000_000;
const RUN_RETENTION_DAYS = 90;
// The sync cron runs every 5 min; "hermes" counts as stale after 3 missed pushes.
const HERMES_EXPECTED_EVERY_MIN = 15;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
// Hermes writes ISO timestamps with microseconds and an offset; anything Date can't parse is rejected.
const ts = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp')
  .transform((s) => new Date(s));
// Long error texts are clipped, not rejected, so one noisy job can't block the whole sync.
const clipped = (max: number) => z.string().max(20_000).transform((s) => s.slice(0, max));

const Job = z.object({
  id,
  name: clipped(200),
  schedule: clipped(100),
  state: z.string().max(32),
  enabled: z.boolean(),
  noAgent: z.boolean(),
  lastRunAt: ts.nullable(),
  lastStatus: z.string().max(32).nullable(),
  lastError: clipped(2000).nullable(),
  failureStreak: z.number().int().min(0).max(100_000),
  nextRunAt: ts.nullable(),
});

const Run = z.object({
  id,
  jobId: id,
  status: z.enum(['claimed', 'running', 'completed', 'failed', 'unknown']),
  startedAt: ts.nullable(),
  finishedAt: ts.nullable(),
  error: clipped(2000).nullable(),
  deliveryOutcome: z.string().max(64).nullable(),
});

const Payload = z.object({
  source: z.enum(['argo']),
  jobs: z.array(Job).max(200),
  runs: z.array(Run).max(500),
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
  const { source, jobs, runs } = parsed.data;
  const now = new Date();

  try {
    await prisma.$transaction([
      // jobs.json is the full list, so jobs missing from it were deleted on Argo.
      prisma.agentJob.deleteMany({ where: { source, id: { notIn: jobs.map((j) => j.id) } } }),
      ...jobs.map((j) =>
        prisma.agentJob.upsert({
          where: { id: j.id },
          create: { ...j, source, syncedAt: now },
          update: { ...j, source, syncedAt: now },
        }),
      ),
      ...runs.map((r) =>
        prisma.agentJobRun.upsert({
          where: { id: r.id },
          create: { ...r, source, syncedAt: now },
          update: { ...r, source, syncedAt: now },
        }),
      ),
      prisma.agentJobRun.deleteMany({
        where: { source, startedAt: { lt: new Date(now.getTime() - RUN_RETENTION_DAYS * 86_400_000) } },
      }),
      prisma.sourceHeartbeat.upsert({
        where: { source: 'hermes' },
        create: { source: 'hermes', lastAttemptAt: now, lastOkAt: now, ok: true, expectedEveryMin: HERMES_EXPECTED_EVERY_MIN },
        update: { lastAttemptAt: now, lastOkAt: now, ok: true, detail: null },
      }),
    ]);
  } catch (err) {
    // Details go to the server log only; the caller gets no DB internals.
    console.error('ingest/hermes-cron failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Write failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, jobs: jobs.length, runs: runs.length });
}
