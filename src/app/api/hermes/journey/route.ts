import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/hermes/journey → session list (mirrored by the bridge) or, when
// ?sessionId= is given, the cached trace for that session.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();

  if (sessionId) {
    const row = await prisma.dataStore.findUnique({ where: { key: `journey:${sessionId}` } });
    return NextResponse.json(row?.data ?? { sessionId, trace: [], fetchedAt: null });
  }

  const row = await prisma.dataStore.findUnique({ where: { key: "hermes-journey" } });
  return NextResponse.json(row?.data ?? { sessions: [], syncedAt: null });
}

// POST /api/hermes/journey { sessionId } → queue a journey.fetch request so
// the bridge exports the full trace and caches it in DataStore.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const sessionId = (b.sessionId || "").toString().trim();
  if (!/^\d{8}_\d{6}_[A-Za-z0-9_]+$/.test(sessionId)) {
    return NextResponse.json({ error: "invalid sessionId" }, { status: 400 });
  }
  try {
    const row = await prisma.agentRequest.create({
      data: {
        origin: "web",
        kind: "journey.fetch",
        title: `Fetch journey: ${sessionId}`,
        prompt: JSON.stringify({ sessionId }),
        sideEffecting: false,
        status: "queued",
      },
    });
    return NextResponse.json({ ok: true, requestId: row.id });
  } catch {
    return NextResponse.json({ error: "failed to queue journey fetch" }, { status: 500 });
  }
}
