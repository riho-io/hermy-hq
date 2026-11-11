import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/require-session";
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  const row = await prisma.dataStore.findUnique({ where: { key: "hermes-health" } });
  return NextResponse.json(row?.data ?? { online: false, gateway: "unknown", lastSeen: null });
}
