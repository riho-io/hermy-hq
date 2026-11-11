import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/require-session";

// GET /api/hermes/channels → messaging platform status mirrored by the bridge
// (from `hermes status`). The bridge stores it under key "hermes-channels".
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    const row = await prisma.dataStore.findUnique({ where: { key: "hermes-channels" } });
    return NextResponse.json(row?.data ?? { channels: [], syncedAt: null });
  } catch {
    return NextResponse.json({ channels: [], syncedAt: null });
  }
}
