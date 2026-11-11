import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/require-session";
import { parseIdsParam } from "@/lib/hermes-requests";

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const url = new URL(req.url);
  const status = url.searchParams.get("status"); // e.g. "awaiting_approval"
  const take = Math.min(Number(url.searchParams.get("take") || 50), 200);
  // ?ids=a,b (max 20): poll only the given rows, e.g. the cron panel's open requests.
  const ids = parseIdsParam(url.searchParams.get("ids"));
  if (ids === "invalid") return NextResponse.json({ error: "bad ids" }, { status: 400 });
  const where = {
    ...(status ? { status: { in: status.split(",") } } : {}),
    ...(ids ? { id: { in: ids } } : {}),
  };
  const requests = await prisma.agentRequest.findMany({
    where, orderBy: { createdAt: "desc" }, take,
  });
  const pending = await prisma.agentRequest.count({ where: { status: "awaiting_approval" } });
  return NextResponse.json({ requests, pending });
}
