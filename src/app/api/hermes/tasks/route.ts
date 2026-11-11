import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/require-session";

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  const tasks = await prisma.hermesTask.findMany({ orderBy: [{ status: "asc" }, { priority: "desc" }], take: 200 });
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const lastSync = tasks[0]?.syncedAt ?? null;
  return NextResponse.json({ tasks, counts, total: tasks.length, lastSync });
}
