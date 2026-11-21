// Pure helpers for /cronid: job state, data freshness, Estonian relative times (Europe/Tallinn).
import type { CronJob } from "@/app/api/hermes/crons/route";
import { describeSchedule } from "./cron-human";

export type JobState = "ok" | "error" | "late" | "paused";

const MIN = 60_000;
export const STALE_AFTER_MIN = 15;
const TZ = "Europe/Tallinn";

export const isFailedStatus = (s: string | null) => s !== null && s !== "ok" && s !== "success";

// Grace before a missed run counts as late: 10 min, or 10% of the interval for slow jobs (max 60 min).
export function lateGraceMs(schedule: string): number {
  const iv = describeSchedule(schedule).intervalMin;
  const pct = iv ? Math.min(iv * 0.1, 60) : 0;
  return Math.max(10, pct) * MIN;
}

// Measured against the sync time, not the clock: if sync lags, stale data must not make every job "late"
// (the stale banner covers that case).
export function isLate(job: CronJob, syncedAt: string | null, now: number): boolean {
  if (job.status !== "active" || !job.nextRun) return false;
  const next = Date.parse(job.nextRun);
  if (Number.isNaN(next)) return false;
  const synced = syncedAt ? Date.parse(syncedAt) : NaN;
  const ref = Number.isNaN(synced) ? now : Math.min(now, synced);
  return next < ref - lateGraceMs(job.schedule);
}

export function jobState(job: CronJob, syncedAt: string | null, now: number): JobState {
  if (job.status === "paused") return "paused";
  if (isFailedStatus(job.lastStatus)) return "error";
  if (isLate(job, syncedAt, now)) return "late";
  return "ok";
}

export function needsAttention(job: CronJob, syncedAt: string | null, now: number): boolean {
  return jobState(job, syncedAt, now) !== "ok" || job.failureStreak > 0;
}

// Plain-language reason for the "Vajab tähelepanu" card.
export function attentionReason(job: CronJob, syncedAt: string | null, now: number): string {
  const st = jobState(job, syncedAt, now);
  const streak = job.failureStreak > 1 ? ` (${job.failureStreak} korda järjest)` : "";
  if (st === "paused") return "Töö on pausil ega käivitu.";
  if (st === "error") return `Viimane käivitus ebaõnnestus${streak}.`;
  if (st === "late") return `Pidi käivituma ${ago(job.nextRun, now)}, aga pole käivitunud.`;
  if (job.failureStreak > 0) return `Hiljuti ebaõnnestus${streak}, viimane käivitus õnnestus.`;
  return "";
}

/* ── data freshness ── */

export type DataHealth =
  | { kind: "ok" }
  | { kind: "failed"; message: string }
  | { kind: "stale"; message: string };

// fetchError: null when the last /api/hermes/crons call succeeded, else a short reason.
export function isStale(syncedAt: string | null, now: number, maxAgeMin = STALE_AFTER_MIN): boolean {
  if (!syncedAt) return true;
  const t = Date.parse(syncedAt);
  return Number.isNaN(t) || now - t > maxAgeMin * MIN;
}

export function dataHealth(fetchError: string | null, syncedAt: string | null, now: number, hasData = true): DataHealth {
  if (fetchError) {
    const tail = hasData ? " Näitan viimast teadaolevat seisu." : "";
    return { kind: "failed", message: `Andmete laadimine ebaõnnestus (${fetchError}).${tail}` };
  }
  if (isStale(syncedAt, now)) {
    const when = syncedAt ? `Viimane sünk ${ago(syncedAt, now)}.` : "Sünki pole kordagi toimunud.";
    return { kind: "stale", message: `Andmed ei uuene — sünk-cron võib olla katki. ${when}` };
  }
  return { kind: "ok" };
}

/* ── time, Europe/Tallinn ── */

const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const WD_FMT = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });
const WD_ET: Record<string, string> = { Mon: "E", Tue: "T", Wed: "K", Thu: "N", Fri: "R", Sat: "L", Sun: "P" };
const MON_SHORT = ["jaan", "veebr", "märts", "apr", "mai", "juuni", "juuli", "aug", "sept", "okt", "nov", "dets"];

function tallinn(ms: number) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const y = Number(p.year), mo = Number(p.month), d = Number(p.day);
  return { dayNum: Date.UTC(y, mo - 1, d) / 86_400_000, mo, d, time: `${p.hour}:${p.minute}` };
}

export function clock(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : tallinn(t).time;
}

function dayWord(t: number, now: number): string {
  const a = tallinn(t);
  const diff = a.dayNum - tallinn(now).dayNum;
  if (diff === 0) return `täna ${a.time}`;
  if (diff === 1) return `homme ${a.time}`;
  if (diff === -1) return `eile ${a.time}`;
  if (diff > 1 && diff < 7) return `${WD_ET[WD_FMT.format(new Date(t))]} ${a.time}`;
  return `${a.d}. ${MON_SHORT[a.mo - 1]} ${a.time}`;
}

export function ago(iso: string | null, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const m = Math.floor((now - t) / MIN);
  if (m < 1) return "just praegu";
  if (m < 60) return `${m} min tagasi`;
  const h = Math.floor(m / 60);
  if (h < 12) return `${h} h tagasi`;
  return dayWord(t, now);
}

export function until(iso: string | null, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const m = Math.round((t - now) / MIN);
  if (m < 0) {
    const late = -m;
    return late < 60 ? `${late} min hiljaks` : `${Math.round(late / 60)} h hiljaks`;
  }
  if (m < 1) return "kohe";
  if (m < 60) return `${m} min pärast`;
  if (m < 6 * 60) return `${Math.round(m / 60)} h pärast`;
  return dayWord(t, now);
}
