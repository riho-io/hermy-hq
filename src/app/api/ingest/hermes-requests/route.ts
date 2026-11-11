import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasIngestSecret } from '@/lib/internal-secret';
import { classifyRow, fromStatuses, NON_APPROVAL_KINDS } from '@/lib/hermes-requests';

// Pull API for the narrow executor on the Hermes server (x-ingest-secret only).
// GET: runnable cron requests. POST: executor reports running | done | failed.
// Allowlist and payload rules live in hermes-actions.ts / hermes-requests.ts; the executor keeps its own copy.

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 20_000;
const MAX_BATCH = 20;

export async function GET(req: NextRequest) {
  if (!hasIngestSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const rows = await prisma.agentRequest.findMany({
      where: {
        OR: [{ status: 'approved' }, { status: 'queued', kind: { in: NON_APPROVAL_KINDS } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 200, // headroom so rejected rows do not starve the batch
      select: { id: true, kind: true, status: true, prompt: true },
    });

    const out: { id: string; kind: string; payload: Record<string, string> }[] = [];
    const rejects = new Map<string, string[]>(); // error -> ids
    for (const row of rows) {
      const v = classifyRow(row);
      if (v.action === 'reject') rejects.set(v.error, [...(rejects.get(v.error) ?? []), row.id]);
      else if (v.action === 'return' && out.length < MAX_BATCH) out.push({ id: row.id, kind: row.kind, payload: v.payload });
    }

    const now = new Date();
    for (const [error, ids] of rejects) {
      // Status is part of the write: a row the executor just claimed is not touched.
      await prisma.agentRequest.updateMany({
        where: { id: { in: ids }, status: { in: ['queued', 'approved'] } },
        data: { status: 'rejected', error, finishedAt: now },
      });
    }
    return NextResponse.json(out);
  } catch (err) {
    console.error('ingest/hermes-requests GET failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Read failed' }, { status: 500 });
  }
}

const Report = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  status: z.enum(['running', 'done', 'failed']),
  result: z.string().max(4000).optional(),
  error: z.string().max(2000).optional(),
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
  const parsed = Report.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', issues: parsed.error.issues.slice(0, 10) }, { status: 400 });
  }
  const { id, status, result, error } = parsed.data;
  const now = new Date();

  try {
    // Precondition lives in the WHERE clause; running additionally needs a kind that may skip approval
    // when the row is still queued (approved rows are already cleared by the approve check).
    const where =
      status === 'running'
        ? { id, OR: [{ status: 'approved' }, { status: 'queued', kind: { in: NON_APPROVAL_KINDS } }] }
        : { id, status: { in: fromStatuses(status) } };
    const { count } = await prisma.agentRequest.updateMany({
      where,
      data:
        status === 'running'
          ? { status, startedAt: now }
          : { status, finishedAt: now, result: result ?? null, error: error ?? null },
    });
    if (count === 0) return NextResponse.json({ error: 'Conflict' }, { status: 409 });
  } catch (err) {
    console.error('ingest/hermes-requests POST failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Write failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
