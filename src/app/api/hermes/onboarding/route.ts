import { NextResponse } from "next/server";
import { requireSession } from "@/lib/require-session";
import { prisma } from "@/lib/prisma";

// GET /api/hermes/onboarding → has the operator completed onboarding?
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
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
export async function POST() {
  const denied = await requireSession();
  if (denied) return denied;
  return NextResponse.json({ error: "disabled: not supported by the executor" }, { status: 400 });
}
