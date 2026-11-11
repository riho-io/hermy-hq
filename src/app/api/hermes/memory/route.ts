import { NextResponse } from "next/server";
import { requireSession } from "@/lib/require-session";
import { prisma } from "@/lib/prisma";

// GET ?q=&type=&status= → list/search wiki entries (mirrored by the bridge)
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status") || "active";
  const where: Record<string, unknown> = {};
  if (status !== "all") where.status = status;
  if (type && type !== "all") where.type = type;
  if (q) where.OR = [
    { title: { contains: q, mode: "insensitive" } },
    { body: { contains: q, mode: "insensitive" } },
    { tags: { has: q.toLowerCase() } },
  ];
  const entries = await prisma.hermesMemory.findMany({ where, orderBy: { updatedAt: "desc" }, take: 300 });
  const all = await prisma.hermesMemory.findMany({ select: { type: true }, where: status === "all" ? {} : { status } });
  const typeCounts: Record<string, number> = {};
  for (const e of all) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  const lastSync = entries[0]?.syncedAt ?? null;
  return NextResponse.json({ entries, typeCounts, total: all.length, lastSync });
}

// POST { path?, id?, type, title, body, tags?, links?, status?, confidence? }
// → queue a wiki write for the bridge (writes the .md file + git commit on the mini).
export async function POST() {
  const denied = await requireSession();
  if (denied) return denied;
  return NextResponse.json({ error: "disabled: not supported by the executor" }, { status: 400 });
}
