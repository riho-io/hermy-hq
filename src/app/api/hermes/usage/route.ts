import { NextResponse } from "next/server";
import { requireSession } from "@/lib/require-session";
import { prisma } from "@/lib/prisma";
import type { UsageBalance, UsageDay, UsageModel, UsageResponse } from "@/lib/usage-summary";

// /kulu data: AgentUsageDay + AgentProfile, filled by hermy_usage_sync.py via /api/ingest/hermes-usage.
// The page filters by period client-side, so this returns the last 31 Tallinn days in one go.
const WINDOW_DAYS = 31;

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const since = new Date(Date.now() - (WINDOW_DAYS + 1) * 86_400_000);
  const [dayRows, profileRows, balanceRow, heartbeat] = await Promise.all([
    prisma.agentUsageDay.findMany({ where: { day: { gte: since } }, orderBy: [{ day: "asc" }, { profile: "asc" }] }),
    prisma.agentProfile.findMany({ orderBy: { profile: "asc" } }),
    prisma.dataStore.findUnique({ where: { key: "hermes-balance" } }),
    prisma.sourceHeartbeat.findUnique({ where: { source: "hermes-usage" } }),
  ]);

  const days: UsageDay[] = dayRows.map((d) => ({
    profile: d.profile,
    day: d.day.toISOString().slice(0, 10),
    sessions: d.sessions,
    emptySessions: d.emptySessions,
    unpricedSessions: d.unpricedSessions,
    subscriptionSessions: d.subscriptionSessions,
    tokens: Number(d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWriteTokens),
    costUsd: d.costUsd,
    subscriptionCostUsd: d.subscriptionCostUsd,
    models: Array.isArray(d.models) ? (d.models as unknown as UsageModel[]) : [],
    platforms: d.platforms && typeof d.platforms === "object" && !Array.isArray(d.platforms) ? (d.platforms as Record<string, number>) : {},
  }));

  const profiles = profileRows.map((p) => ({
    profile: p.profile,
    displayName: p.displayName,
    model: p.model,
    provider: p.provider,
    subscription: p.subscription,
    gateway: p.gateway,
    cronCount: p.cronCount,
    cronEnabled: p.cronEnabled,
  }));

  const b = balanceRow?.data as Partial<UsageBalance> | null | undefined;
  const balance: UsageBalance | null =
    b && typeof b.balanceUsd === "number" ? { balanceUsd: b.balanceUsd, checkedAt: typeof b.checkedAt === "string" ? b.checkedAt : null } : null;

  const body: UsageResponse = { days, profiles, balance, syncedAt: heartbeat?.lastOkAt?.toISOString() ?? null };
  return NextResponse.json(body);
}
