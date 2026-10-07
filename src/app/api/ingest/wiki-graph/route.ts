import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hasIngestSecret } from '@/lib/internal-secret';
import { WikiPayload, normalizeWikiPayload } from '@/lib/wiki-graph';

// Argo's wiki_graph_sync.py pushes the whole Syncthing-shared wiki graph once an hour.
// The source is fixed by the ingest key (only Argo holds it); the row is replaced on every push.

const MAX_BODY_BYTES = 2_000_000;
// Hourly cron; "wiki" counts as stale after ~3 missed pushes.
const WIKI_EXPECTED_EVERY_MIN = 180;

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

  const parsed = WikiPayload.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', issues: parsed.error.issues.slice(0, 10) }, { status: 400 });
  }
  const { graph, counts, pcLastSeenAt } = normalizeWikiPayload(parsed.data);
  const now = new Date();
  const row = {
    graph: graph as unknown as Prisma.InputJsonValue,
    noteCount: counts.notes,
    linkCount: counts.links,
    unresolvedCount: counts.unresolved,
    orphanCount: counts.orphans,
    pcLastSeenAt,
    generatedAt: now,
  };

  try {
    await prisma.$transaction([
      prisma.wikiSnapshot.upsert({ where: { source: 'wiki' }, create: { source: 'wiki', ...row }, update: row }),
      prisma.sourceHeartbeat.upsert({
        where: { source: 'wiki' },
        create: {
          source: 'wiki',
          lastAttemptAt: now,
          lastOkAt: now,
          ok: true,
          detail: `${counts.notes} märget`,
          expectedEveryMin: WIKI_EXPECTED_EVERY_MIN,
        },
        update: { lastAttemptAt: now, lastOkAt: now, ok: true, detail: `${counts.notes} märget` },
      }),
    ]);
  } catch (err) {
    // Details go to the server log only; the caller gets no DB internals.
    console.error('ingest/wiki-graph failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Write failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, notes: counts.notes, links: counts.links });
}
