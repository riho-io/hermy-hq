import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/require-session";

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const take = Math.min(Number(new URL(req.url).searchParams.get("take") || 40), 100);
  const events = await prisma.agentEvent.findMany({ orderBy: { createdAt: "desc" }, take });
  return NextResponse.json({ events });
}
