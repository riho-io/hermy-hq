import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/require-session";

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  const row = await prisma.dataStore.findUnique({ where: { key: "hermes-cost" } });
  return NextResponse.json(row?.data ?? { summary: null, byModel: [], totalCost: null, totalTokens: null, syncedAt: null });
}
