import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasIngestSecret } from '@/lib/internal-secret';

// Argo's hermy_usage_sync.py pushes usage per profile per day (last 35 days, recomputed hourly),
// a snapshot of all profiles and the last account balance. Write-only for Argo; /kulu reads via Prisma.

const MAX_BODY_BYTES = 1_000_000;
// The sync cron runs hourly; "hermes-usage" counts as stale after 3 missed pushes.
const EXPECTED_EVERY_MIN = 180;

const profileId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const count = z.number().int().min(0).max(10_000_000);
const tokens = z.number().int().min(0).max(1e15);
const usd = z.number().min(0).max(1_000_000).nullable();
const clipped = (max: number) => z.string().max(2_000).transform((s) => s.slice(0, max));

const Model = z.object({
  model: clipped(100),
  sessions: count,
  tokens,
  costUsd: usd,
  subscription: z.boolean(),
});

const Day = z.object({
  profile: profileId,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'invalid day'),
  sessions: count,
  emptySessions: count,
  unpricedSessions: count,
  subscriptionSessions: count,
  inputTokens: tokens,
  outputTokens: tokens,
  cacheReadTokens: tokens,
  cacheWriteTokens: tokens,
  costUsd: usd,
  subscriptionCostUsd: usd,
  models: z.array(Model).max(50),
  platforms: z.record(z.string().regex(/^[a-z0-9_-]{1,32}$/), count).refine((o) => Object.keys(o).length <= 30, 'too many platforms'),
});

const Profile = z.object({
  profile: profileId,
  displayName: clipped(64).nullable(),
  model: clipped(100).nullable(),
  provider: clipped(100).nullable(),
  subscription: z.boolean(),
  gateway: z.string().max(32).nullable(),
  cronCount: count,
  cronEnabled: count,
});

const Payload = z.object({
  source: z.enum(['argo']),
  days: z.array(Day).max(2_000),
  profiles: z.array(Profile).max(100),
  balance: z
    .object({
      balanceUsd: z.number().min(-1_000_000).max(1_000_000),
      checkedAt: z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp').nullable(),
    })
    .nullable(),
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
  const { source, days, profiles, balance } = parsed.data;
  // Argo always has at least the default profile; an empty list is a read failure, not "all profiles removed".
  if (profiles.length === 0) {
    return NextResponse.json({ error: 'Empty profiles snapshot refused' }, { status: 400 });
  }
  const now = new Date();

  try {
    await prisma.$transaction([
      // Usage rows are never deleted here: Hermes may prune old sessions, and a recomputed day only
      // replaces the same (source, profile, day) key.
      ...days.map((d) => {
        const data = {
          sessions: d.sessions,
          emptySessions: d.emptySessions,
          unpricedSessions: d.unpricedSessions,
          subscriptionSessions: d.subscriptionSessions,
          inputTokens: BigInt(d.inputTokens),
          outputTokens: BigInt(d.outputTokens),
          cacheReadTokens: BigInt(d.cacheReadTokens),
          cacheWriteTokens: BigInt(d.cacheWriteTokens),
          costUsd: d.costUsd,
          subscriptionCostUsd: d.subscriptionCostUsd,
          models: d.models,
          platforms: d.platforms,
          syncedAt: now,
        };
        const day = new Date(`${d.day}T00:00:00Z`);
        return prisma.agentUsageDay.upsert({
          where: { source_profile_day: { source, profile: d.profile, day } },
          create: { source, profile: d.profile, day, ...data },
          update: data,
        });
      }),
      // The profile list is a full snapshot, so profiles missing from it were removed on Argo.
      prisma.agentProfile.deleteMany({ where: { source, profile: { notIn: profiles.map((p) => p.profile) } } }),
      ...profiles.map((p) =>
        prisma.agentProfile.upsert({
          where: { source_profile: { source, profile: p.profile } },
          create: { ...p, source, syncedAt: now },
          update: { ...p, syncedAt: now },
        }),
      ),
      ...(balance
        ? [
            prisma.dataStore.upsert({
              where: { key: 'hermes-balance' },
              create: { key: 'hermes-balance', data: balance },
              update: { data: balance },
            }),
          ]
        : []),
      prisma.sourceHeartbeat.upsert({
        where: { source: 'hermes-usage' },
        create: { source: 'hermes-usage', lastAttemptAt: now, lastOkAt: now, ok: true, expectedEveryMin: EXPECTED_EVERY_MIN },
        update: { lastAttemptAt: now, lastOkAt: now, ok: true, detail: null },
      }),
    ]);
  } catch (err) {
    // Details go to the server log only; the caller gets no DB internals.
    console.error('ingest/hermes-usage failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Write failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, days: days.length, profiles: profiles.length });
}
