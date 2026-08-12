import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Exact allowlist of onboarding fields — never accept arbitrary keys.
const ALLOWED_FIELDS = new Set([
  "nimi", "ettevõte", "roll", "nišš", "auditoorium", "hääl", "eesmärk", "prioriteedid",
]);
const MAX_FIELD_LEN = 200;
const MAX_TOTAL = 2000;

// GET /api/hermes/onboarding → has the operator completed onboarding?
export async function GET() {
  try {
    const row = await prisma.dataStore.findUnique({ where: { key: "hermes-onboarding" } });
    const data = (row?.data ?? {}) as { done?: boolean; profile?: Record<string, string> };
    const done = Boolean(data.done);
    return NextResponse.json({ done, profile: data.profile ?? null });
  } catch {
    return NextResponse.json({ done: false, profile: null });
  }
}

// POST /api/hermes/onboarding { answers: {...} }
// Queues an onboarding.write request: the bridge writes the answers into the
// Hermes user profile (USER.md) so every future session knows the operator.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const answers = b.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return NextResponse.json({ error: "answers object required" }, { status: 400 });
  }

  // Validate: only allowlisted string keys, per-field + total length caps.
  const clean: Record<string, string> = {};
  let total = 0;
  for (const [k, v] of Object.entries(answers)) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    if (typeof v !== "string") return NextResponse.json({ error: `field ${k} must be a string` }, { status: 400 });
    const val = v.trim().slice(0, MAX_FIELD_LEN);
    total += val.length;
    if (total > MAX_TOTAL) return NextResponse.json({ error: "payload too large" }, { status: 400 });
    if (val) clean[k] = val;
  }
  if (Object.keys(clean).length === 0) {
    return NextResponse.json({ error: "no valid answers" }, { status: 400 });
  }

  try {
    const row = await prisma.agentRequest.create({
      data: {
        origin: "web",
        kind: "onboarding.write",
        title: "Onboarding interview completed",
        prompt: JSON.stringify(clean),
        sideEffecting: false,
        status: "queued",
      },
    });
    // Optimistically mark done so the UI doesn't nag again; the bridge writes
    // USER.md in the background and the DataStore is updated on success.
    await prisma.dataStore.upsert({
      where: { key: "hermes-onboarding" },
      create: { key: "hermes-onboarding", data: { done: true, profile: clean, submittedAt: new Date().toISOString(), requestId: row.id } },
      update: { data: { done: true, profile: clean, submittedAt: new Date().toISOString(), requestId: row.id } },
    });
    return NextResponse.json({ ok: true, requestId: row.id });
  } catch {
    return NextResponse.json({ error: "failed to save onboarding" }, { status: 500 });
  }
}
