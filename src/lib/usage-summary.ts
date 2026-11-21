// Pure helpers for /kulu: period totals, per-profile rows, "Vajab tähelepanu", data freshness.
// Days are Europe/Tallinn calendar days ('YYYY-MM-DD'), as hermy_usage_sync.py buckets them.
import { ago, isStale, type DataHealth } from "./cron-status";

export type UsageModel = { model: string; sessions: number; tokens: number; costUsd: number | null; subscription: boolean };

export type UsageDay = {
  profile: string;
  day: string;
  sessions: number;
  emptySessions: number;
  unpricedSessions: number;
  subscriptionSessions: number;
  tokens: number; // input + output + cache read + cache write, as `hermes insights` counts them
  costUsd: number | null;
  subscriptionCostUsd: number | null;
  models: UsageModel[];
  platforms: Record<string, number>;
};

export type UsageProfile = {
  profile: string;
  displayName: string | null;
  model: string | null;
  provider: string | null;
  subscription: boolean;
  gateway: string | null;
  cronCount: number;
  cronEnabled: number;
};

export type UsageBalance = { balanceUsd: number; checkedAt: string | null };

export type UsageResponse = {
  days: UsageDay[];
  profiles: UsageProfile[];
  balance: UsageBalance | null;
  syncedAt: string | null;
};

export type Period = "today" | "7d" | "30d";
export const PERIOD_DAYS: Record<Period, number> = { today: 1, "7d": 7, "30d": 30 };

// Hourly sync: stale after 3 missed runs (same window as the route's heartbeat).
export const USAGE_STALE_AFTER_MIN = 180;
const TZ = "Europe/Tallinn";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export function tallinnDay(ms: number): string {
  return dayFmt.format(new Date(ms));
}

export function periodStartDay(period: Period, now: number): string {
  const [y, m, d] = tallinnDay(now).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d - (PERIOD_DAYS[period] - 1)));
  return start.toISOString().slice(0, 10);
}

export type ProfileRow = {
  profile: string;
  label: string;
  alias: string | null; // profile id, shown when a display name exists
  model: string | null;
  subscription: boolean;
  gateway: string | null;
  cronCount: number;
  cronEnabled: number;
  sessions: number;
  unpricedSessions: number;
  tokens: number;
  costUsd: number | null;
};

export type Attention = { kind: "unpriced" | "gateway" | "idle"; text: string };

export type UsageSummary = {
  totals: { costUsd: number; unpricedSessions: number; tokens: number; sessions: number; subscriptionCostUsd: number };
  rows: ProfileRow[];
  attention: Attention[];
  maxTokens: number;
};

const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function labelOf(p: Pick<UsageProfile, "profile" | "displayName">): string {
  return p.displayName || p.profile;
}

export function summarize(days: UsageDay[], profiles: UsageProfile[], period: Period, now: number): UsageSummary {
  const first = periodStartDay(period, now);
  const inPeriod = days.filter((d) => d.day >= first);
  const known = new Map(profiles.map((p) => [p.profile, p]));
  // Usage of a profile that no longer exists still counts in the totals and gets a bare row.
  const ids = [...new Set([...profiles.map((p) => p.profile), ...inPeriod.map((d) => d.profile)])];

  const rows: ProfileRow[] = ids.map((id) => {
    const p = known.get(id);
    const mine = inPeriod.filter((d) => d.profile === id);
    return {
      profile: id,
      label: p ? labelOf(p) : id,
      alias: p?.displayName ? id : null,
      model: p?.model ?? null,
      subscription: p?.subscription ?? false,
      gateway: p?.gateway ?? null,
      cronCount: p?.cronCount ?? 0,
      cronEnabled: p?.cronEnabled ?? 0,
      sessions: mine.reduce((s, d) => s + d.sessions, 0),
      unpricedSessions: mine.reduce((s, d) => s + d.unpricedSessions, 0),
      tokens: mine.reduce((s, d) => s + d.tokens, 0),
      costUsd: mine.reduce<number | null>((s, d) => add(s, d.costUsd), null),
    };
  });
  rows.sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions || a.label.localeCompare(b.label, "et"));

  const totals = {
    costUsd: inPeriod.reduce((s, d) => s + (d.costUsd ?? 0), 0),
    unpricedSessions: inPeriod.reduce((s, d) => s + d.unpricedSessions, 0),
    tokens: inPeriod.reduce((s, d) => s + d.tokens, 0),
    sessions: inPeriod.reduce((s, d) => s + d.sessions, 0),
    subscriptionCostUsd: inPeriod.reduce((s, d) => s + (d.subscriptionCostUsd ?? 0), 0),
  };

  const attention: Attention[] = [];
  for (const r of rows.filter((r) => r.unpricedSessions > 0)) {
    attention.push({
      kind: "unpriced",
      text: `${r.label}: ${plural(r.unpricedSessions, "sessioon", "sessiooni")} ilma hinnata — kulu on alahinnatud.`,
    });
  }
  for (const r of rows.filter((r) => r.gateway !== null && r.gateway !== "running")) {
    attention.push({ kind: "gateway", text: `${r.label}: gateway ei tööta (${r.gateway}).` });
  }
  const idle = rows.filter((r) => known.has(r.profile) && r.sessions === 0).map((r) => r.label);
  if (idle.length > 0) {
    attention.push({
      kind: "idle",
      text: `${idle.length === 1 ? "Profiil pole" : "Need profiilid pole"} perioodil ühtegi sessiooni teinud: ${idle.join(", ")}.`,
    });
  }

  return { totals, rows, attention, maxTokens: Math.max(0, ...rows.map((r) => r.tokens)) };
}

export function usageHealth(fetchError: string | null, syncedAt: string | null, now: number, hasData = true): DataHealth {
  if (fetchError) {
    const tail = hasData ? " Näitan viimast teadaolevat seisu." : "";
    return { kind: "failed", message: `Andmete laadimine ebaõnnestus (${fetchError}).${tail}` };
  }
  if (isStale(syncedAt, now, USAGE_STALE_AFTER_MIN)) {
    const when = syncedAt ? `Viimane sünk ${ago(syncedAt, now)}.` : "Sünki pole kordagi toimunud.";
    return { kind: "stale", message: `Kuluandmed ei uuene — Argo kulu-sünk võib olla katki. ${when}` };
  }
  return { kind: "ok" };
}

/* ── formatting ── */

export function fmtUsd(n: number | null): string {
  if (n === null) return "—";
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

const nf1 = new Intl.NumberFormat("et-EE", { maximumFractionDigits: 1 });
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${nf1.format(n / 1_000_000)} M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} k`;
  return String(n);
}
