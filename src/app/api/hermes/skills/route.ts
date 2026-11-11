import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/require-session";

// GET /api/hermes/skills → skills inventory from the bridge-mirrored
// DataStore ("hermes-skills"). The bridge runs `hermes journey --json`
// (or `hermes skills list`) and mirrors the result here.
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    const row = await prisma.dataStore.findUnique({ where: { key: "hermes-skills" } });
    return NextResponse.json(row?.data ?? { skills: [], syncedAt: null });
  } catch {
    return NextResponse.json({ skills: [], syncedAt: null });
  }
}
