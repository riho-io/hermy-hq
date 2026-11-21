"use client";

// /cronid — "is everything OK?" view of all Hermes cron jobs.
// Data: GET /api/hermes/crons (session-protected). Actions reuse POST /api/hermes/crons and
// request-status polling the same way src/components/hermes-cron-panel.tsx does.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Zap, Pause, Play, Clock, ChevronDown, AlertTriangle, Eye } from "lucide-react";
import { Eyebrow, Panel, Skeleton } from "@/components/ui/kit";
import type { CronJob } from "@/app/api/hermes/crons/route";
import { describeSchedule, type CronGroup } from "@/lib/cron-human";
import { jobState, needsAttention, attentionReason, dataHealth, ago, until, clock, type JobState } from "@/lib/cron-status";

type ReqState = { id: string; status: string; error: string | null };

const PRESETS = ["raport", "hoiatus", "vait"] as const;
const TERMINAL = new Set(["done", "failed", "rejected"]);
const REQ_POLL_MS = 10_000;
const DATA_POLL_MS = 30_000;

// Pill colours: ok teal, error orange, late purple, paused grey (never red). All ≥4.5:1 on --surface-1.
const STATE: Record<JobState, { label: string; color: string; mark: string }> = {
  ok: { label: "Korras", color: "#5fd0a0", mark: "✓" },
  error: { label: "Viga", color: "#f5a25b", mark: "!" },
  late: { label: "Hilineb", color: "#b9a2ff", mark: "◷" },
  paused: { label: "Pausil", color: "#a0a3a8", mark: "‖" },
};
const FILTERS: JobState[] = ["ok", "error", "late", "paused"];

const GROUPS: { key: CronGroup; label: string }[] = [
  { key: "valvur", label: "Valvurid" },
  { key: "paev", label: "Igapäevased" },
  { key: "nadal", label: "Iganädalased" },
  { key: "kuu", label: "Kuised / muud" },
];

const keyOf = (j: CronJob) => `${j.profile}:${j.id}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function reqLabel(r: ReqState): { text: string; color: string } {
  switch (r.status) {
    case "queued":
    case "approved":
      return { text: "Ootel.", color: "var(--text-2)" };
    case "awaiting_approval":
      return { text: "Ootab Sinu kinnitust.", color: "var(--warn)" };
    case "running":
      return { text: "Käib…", color: "var(--accent)" };
    case "done":
      return { text: "Tehtud.", color: "var(--up)" };
    case "failed":
      return { text: `Viga: ${(r.error || "tundmatu").slice(0, 160)}`, color: "#f5a25b" };
    case "rejected":
      return { text: "Tagasi lükatud.", color: "var(--text-2)" };
    default:
      return { text: r.status, color: "var(--text-2)" };
  }
}

const btn =
  "btn-ghost inline-flex items-center justify-center gap-2 min-h-[44px] px-4 text-[14px] font-medium disabled:opacity-40 disabled:pointer-events-none";

/* ── actions: same request flow as hermes-cron-panel.tsx ── */
function useCronActions(onDone: () => void) {
  const [reqs, setReqs] = useState<Record<string, ReqState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const reqsRef = useRef(reqs);
  const commitReqs = useCallback((next: Record<string, ReqState>) => {
    reqsRef.current = next;
    setReqs(next);
  }, []);
  const pollAbort = useRef<AbortController | null>(null);
  useEffect(() => () => pollAbort.current?.abort(), []);

  const send = async (job: CronJob, body: Record<string, string>) => {
    const k = keyOf(job);
    setBusy(k);
    setErrors((e) => ({ ...e, [k]: "" }));
    try {
      const r = await fetch("/api/hermes/crons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: job.id, profile: job.profile, ...body }),
      });
      const j = (await r.json().catch(() => ({}))) as { request?: ReqState; error?: string };
      if (!r.ok || !j.request) {
        setErrors((e) => ({ ...e, [k]: j.error ? `Päring ebaõnnestus: ${j.error}` : "Päring ebaõnnestus." }));
        return;
      }
      const q = j.request;
      commitReqs({ ...reqsRef.current, [k]: { id: q.id, status: q.status, error: q.error ?? null } });
    } catch {
      setErrors((e) => ({ ...e, [k]: "Päring ebaõnnestus." }));
    } finally {
      setBusy(null);
    }
  };

  const pollOnce = useCallback(async () => {
    const open = Object.values(reqsRef.current).filter((r) => !TERMINAL.has(r.status));
    if (open.length === 0) return;
    pollAbort.current?.abort();
    const ctrl = new AbortController();
    pollAbort.current = ctrl;
    try {
      const ids = open.slice(0, 20).map((r) => r.id).join(","); // route caps ?ids= at 20
      const r = await fetch(`/api/hermes/requests?ids=${encodeURIComponent(ids)}`, { signal: ctrl.signal });
      if (!r.ok) return;
      const { requests } = (await r.json()) as { requests: ReqState[] };
      const byId = new Map(requests.map((q) => [q.id, q]));
      const prev = reqsRef.current;
      const next = { ...prev };
      let changed = false;
      let finished = false;
      for (const [k, cur] of Object.entries(prev)) {
        const q = byId.get(cur.id);
        if (q && q.status !== cur.status) {
          next[k] = { id: cur.id, status: q.status, error: q.error ?? null };
          changed = true;
          if (TERMINAL.has(q.status)) finished = true;
        }
      }
      if (changed) commitReqs(next);
      if (finished) onDone();
    } catch {
      /* aborted, or next tick retries */
    }
  }, [onDone, commitReqs]);

  const hasOpen = Object.values(reqs).some((r) => !TERMINAL.has(r.status));
  useEffect(() => {
    if (!hasOpen) return;
    const iv = setInterval(pollOnce, REQ_POLL_MS);
    return () => clearInterval(iv);
  }, [hasOpen, pollOnce]);

  return { reqs, busy, errors, send };
}
type Actions = ReturnType<typeof useCronActions>;

/* ── small pieces ── */
function StatePill({ state }: { state: JobState }) {
  const s = STATE[state];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[14px] font-medium whitespace-nowrap"
      style={{ color: s.color, background: `color-mix(in srgb, ${s.color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${s.color} 30%, transparent)` }}
    >
      <span aria-hidden>{s.mark}</span>
      {s.label}
    </span>
  );
}

function Feedback({ job, actions }: { job: CronJob; actions: Actions }) {
  const k = keyOf(job);
  const err = actions.errors[k];
  const r = actions.reqs[k];
  const label = r ? reqLabel(r) : null;
  if (!err && !label) return null;
  return (
    <p className="text-[14px] break-words" style={{ color: err ? "#f5a25b" : label?.color }} aria-live="polite">
      {err || label?.text}
    </p>
  );
}

function ErrorText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 120 || text.includes("\n");
  return (
    <div className="text-[14px] text-[var(--text-2)]">
      <p className={`num break-words ${open ? "whitespace-pre-wrap" : "truncate"}`}>{text}</p>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 min-h-[44px] text-[14px] text-[var(--accent)] underline underline-offset-2">
          {open ? "Näita vähem" : "Näita kogu viga"}
        </button>
      )}
    </div>
  );
}

function RunButtons({ job, actions }: { job: CronJob; actions: Actions }) {
  const disabled = actions.busy === keyOf(job);
  return (
    <>
      {job.status === "active" ? (
        <button type="button" className={btn} disabled={disabled} onClick={() => actions.send(job, { op: "pause" })}>
          <Pause className="w-4 h-4" aria-hidden /> Peata
        </button>
      ) : (
        <button type="button" className={btn} disabled={disabled} onClick={() => actions.send(job, { op: "resume" })}>
          <Play className="w-4 h-4" aria-hidden /> Jätka
        </button>
      )}
      <button type="button" className={btn} disabled={disabled} onClick={() => actions.send(job, { op: "run" })}>
        <Zap className="w-4 h-4" aria-hidden /> Käivita kohe
      </button>
    </>
  );
}

/* ── expanded row: details + all controls ── */
function JobDetails({ job, actions }: { job: CronJob; actions: Actions }) {
  const [sched, setSched] = useState("");
  const disabled = actions.busy === keyOf(job);
  const submit = () => {
    if (sched.trim()) actions.send(job, { op: "schedule", schedule: sched.trim() });
  };
  return (
    <div className="px-4 pb-4 pt-1 space-y-4 text-[14px]">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-[var(--text-2)]">Ajakava</dt>
        <dd className="num text-[var(--text)] break-all">{job.schedule}</dd>
        <dt className="text-[var(--text-2)]">Profiil</dt>
        <dd className="text-[var(--text)]">{job.profile}</dd>
        <dt className="text-[var(--text-2)]">Viimati</dt>
        <dd className="text-[var(--text)]">{job.lastRun ? `${clock(job.lastRun)} · ${job.lastStatus ?? "—"}` : "—"}</dd>
        {job.failureStreak > 0 && (
          <>
            <dt className="text-[var(--text-2)]">Vigu järjest</dt>
            <dd className="text-[var(--text)]">{job.failureStreak}</dd>
          </>
        )}
      </dl>

      {job.lastError && (
        <div>
          <p className="text-[var(--text-2)] mb-1">Viimane viga</p>
          <p className="num whitespace-pre-wrap break-words text-[var(--text)] bg-[var(--bg)] border border-[var(--line)] rounded-[10px] p-3">{job.lastError}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <RunButtons job={job} actions={actions} />
        <label className="flex items-center gap-2 text-[var(--text-2)]">
          Telegram
          <select
            value={job.telegram}
            disabled={disabled}
            onChange={(e) => {
              if (e.target.value !== job.telegram) actions.send(job, { op: "deliver", preset: e.target.value });
            }}
            className="min-h-[44px] bg-[var(--surface-2)] text-[14px] text-[var(--text)] px-3 rounded-[10px] border border-[var(--line)]"
          >
            {job.telegram === "muu" && <option value="muu" disabled>muu</option>}
            {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <label className="sr-only" htmlFor={`sched-${keyOf(job)}`}>Uus ajakava</label>
        <input
          id={`sched-${keyOf(job)}`}
          value={sched}
          onChange={(e) => setSched(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder="Uus ajakava (nt 0 9 * * 1)"
          className="flex-1 min-w-0 min-h-[44px] bg-transparent num text-[14px] text-[var(--text)] placeholder:text-[var(--text-2)] px-3 rounded-[10px] border border-[var(--line)]"
        />
        <button type="button" className={btn} disabled={disabled || !sched.trim()} onClick={submit}>
          <Clock className="w-4 h-4" aria-hidden /> Saada kinnitamiseks
        </button>
      </div>
      {sched.trim() && (
        <p className="text-[var(--text-2)]">Tähendab: {describeSchedule(sched.trim()).text}</p>
      )}

      <Feedback job={job} actions={actions} />
      <p className="text-[var(--text-2)]">Kustutamine: küsi CC-lt.</p>
    </div>
  );
}

/* ── one job row (card on phone) ── */
function JobRow({
  job, state, now, open, onToggle, actions,
}: { job: CronJob; state: JobState; now: number; open: boolean; onToggle: () => void; actions: Actions }) {
  const k = keyOf(job);
  return (
    <li id={`job-${k}`} className="border-t border-[var(--line)] first:border-t-0 scroll-mt-24">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`det-${k}`}
        className="w-full text-left px-4 py-3 min-h-[56px] grid gap-x-4 gap-y-1 grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center hover:bg-[var(--surface-2)] transition-colors"
      >
        <span className="text-[15px] font-medium text-[var(--text)] truncate">{job.name}</span>
        <span className="md:order-last justify-self-end"><StatePill state={state} /></span>
        <span className="text-[14px] text-[var(--text-2)] truncate col-span-2 md:col-span-1">{describeSchedule(job.schedule).text}</span>
        <span className="text-[14px] text-[var(--text-2)]">
          <span className="md:hidden">Viimati </span>{ago(job.lastRun, now)}
        </span>
        <span className="text-[14px] text-[var(--text-2)] flex items-center justify-between gap-2">
          <span>
            <span className="md:hidden">Järgmine </span>
            {job.status === "active" ? until(job.nextRun, now) : "—"}
          </span>
          <ChevronDown className={`w-4 h-4 shrink-0 md:hidden transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </span>
      </button>
      {open && (
        <div id={`det-${k}`}>
          <JobDetails job={job} actions={actions} />
        </div>
      )}
    </li>
  );
}

/* ── page ── */
export default function CronidPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<JobState | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<CronGroup>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const r = await fetch("/api/hermes/crons", { cache: "no-store", signal: ctrl.signal });
      if (!r.ok) {
        setFetchError(r.status === 401 ? "sessioon aegunud, logi uuesti sisse" : `HTTP ${r.status}`);
      } else {
        const j = (await r.json()) as { jobs?: CronJob[]; syncedAt?: string | null };
        if (!Array.isArray(j.jobs)) throw new Error("vigane vastus");
        setJobs(j.jobs);
        setSyncedAt(j.syncedAt ?? null);
        setFetchError(null);
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setFetchError(e instanceof Error && e.message === "vigane vastus" ? "vigane vastus" : "võrguviga");
    }
    setNow(Date.now());
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, DATA_POLL_MS);
    return () => {
      clearInterval(iv);
      abort.current?.abort();
    };
  }, [load]);

  const actions = useCronActions(load);

  const rows = useMemo(
    () => jobs.map((j) => ({ job: j, state: jobState(j, syncedAt, now), group: describeSchedule(j.schedule).group })),
    [jobs, syncedAt, now],
  );
  const counts = useMemo(() => {
    const c: Record<JobState, number> = { ok: 0, error: 0, late: 0, paused: 0 };
    for (const r of rows) c[r.state]++;
    return c;
  }, [rows]);
  const attention = rows.filter((r) => needsAttention(r.job, syncedAt, now) && (!filter || r.state === filter));
  const attentionTotal = rows.filter((r) => needsAttention(r.job, syncedAt, now)).length;
  const health = loaded ? dataHealth(fetchError, syncedAt, now, jobs.length > 0) : { kind: "ok" as const };

  const manualRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const toggleGroup = (g: CronGroup) =>
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });

  const viewJob = (job: CronJob, group: CronGroup) => {
    const k = keyOf(job);
    setOpenGroups((s) => new Set(s).add(group));
    setExpanded(k);
    requestAnimationFrame(() => document.getElementById(`job-${k}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const headline = !loaded
    ? "Laen…"
    : fetchError && jobs.length === 0
      ? "Andmeid ei saa kätte."
      : attentionTotal === 0
        ? health.kind === "ok" ? "Kõik töötab." : "Seis pole kindel — andmed on vanad."
        : attentionTotal === 1
          ? "1 töö vajab tähelepanu."
          : `${attentionTotal} tööd vajavad tähelepanu.`;

  return (
    <div className="relative z-10 w-full max-w-5xl mx-auto pb-16 text-[14px]">
      <header className="hq-rise pt-4 pb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div className="min-w-0">
          <Eyebrow>Hermes · cronid</Eyebrow>
          <h1 className="mt-2 text-[30px] sm:text-[36px] font-semibold tracking-[-0.02em] text-[var(--text)]">{headline}</h1>
          <p className="mt-1 text-[14px] text-[var(--text-2)]">
            {syncedAt ? `Andmed uuendatud ${clock(syncedAt)} · ${ago(syncedAt, now)}` : loaded ? "Sünkimise aeg teadmata" : " "}
          </p>
        </div>
        <button type="button" onClick={manualRefresh} disabled={refreshing} className={`${btn} self-start sm:self-auto`}>
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden /> Värskenda
        </button>
      </header>

      {health.kind !== "ok" && (
        <div
          role="alert"
          className="mb-6 flex items-start gap-3 rounded-[14px] p-4 text-[15px] text-[var(--text)]"
          style={{
            background: `color-mix(in srgb, ${health.kind === "failed" ? "var(--down)" : "#f5a25b"} 14%, transparent)`,
            border: `1px solid color-mix(in srgb, ${health.kind === "failed" ? "var(--down)" : "#f5a25b"} 45%, transparent)`,
          }}
        >
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: health.kind === "failed" ? "var(--down)" : "#f5a25b" }} aria-hidden />
          <p>{health.message}</p>
        </div>
      )}

      {!loaded ? (
        <div className="space-y-4" aria-busy="true" aria-label="Laen">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {FILTERS.map((f) => <Skeleton key={f} className="h-24" />)}
          </div>
          <Skeleton className="h-32" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : (
        <>
          {/* counters = filters */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
            {FILTERS.map((f) => {
              const s = STATE[f];
              const active = filter === f;
              return (
                <button
                  key={f}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(active ? null : f)}
                  className="panel text-left p-4 min-h-[88px] hover:bg-[var(--surface-2)] transition-colors"
                  style={active ? { borderColor: s.color, boxShadow: `inset 0 0 0 1px ${s.color}` } : undefined}
                >
                  <span className="block text-[14px] font-medium" style={{ color: s.color }}>
                    <span aria-hidden>{s.mark}</span> {s.label}
                  </span>
                  <span className="block mt-1 num text-[32px] font-semibold text-[var(--text)]">{counts[f]}</span>
                </button>
              );
            })}
          </div>
          {filter && (
            <p className="-mt-5 mb-6 text-[14px] text-[var(--text-2)]">
              Näitan ainult: {STATE[filter].label}.{" "}
              <button type="button" onClick={() => setFilter(null)} className="min-h-[44px] text-[var(--accent)] underline underline-offset-2">
                Näita kõiki
              </button>
            </p>
          )}

          {/* needs attention */}
          <section className="mb-10" aria-labelledby="att-h">
            <h2 id="att-h" className="text-[19px] font-semibold text-[var(--text)] mb-3">Vajab tähelepanu</h2>
            {attention.length === 0 ? (
              <p className="text-[15px] text-[var(--text-2)]">Midagi ei vaja tähelepanu.</p>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {attention.map(({ job, state, group }) => (
                  <li key={keyOf(job)}>
                    <Panel className="p-4 h-full flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[16px] font-medium text-[var(--text)] break-words">{job.name}</p>
                          <p className="text-[14px] text-[var(--text-2)]">{describeSchedule(job.schedule).text} · {job.profile}</p>
                        </div>
                        <StatePill state={state} />
                      </div>
                      <p className="text-[15px] text-[var(--text)]">{attentionReason(job, syncedAt, now)}</p>
                      {job.lastError && <ErrorText text={job.lastError} />}
                      <div className="flex flex-wrap gap-2 mt-auto">
                        {job.status === "paused" ? (
                          <button type="button" className={btn} disabled={actions.busy === keyOf(job)} onClick={() => actions.send(job, { op: "resume" })}>
                            <Play className="w-4 h-4" aria-hidden /> Jätka
                          </button>
                        ) : (
                          <button type="button" className={btn} disabled={actions.busy === keyOf(job)} onClick={() => actions.send(job, { op: "run" })}>
                            <Zap className="w-4 h-4" aria-hidden /> Käivita kohe
                          </button>
                        )}
                        <button type="button" className={btn} onClick={() => viewJob(job, group)}>
                          <Eye className="w-4 h-4" aria-hidden /> Vaata
                        </button>
                      </div>
                      <Feedback job={job} actions={actions} />
                    </Panel>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* groups */}
          <div className="space-y-3">
            {GROUPS.map(({ key, label }) => {
              const all = rows.filter((r) => r.group === key);
              if (all.length === 0) return null;
              const shown = filter ? all.filter((r) => r.state === filter) : all;
              if (filter && shown.length === 0) return null;
              const bad = all.filter((r) => needsAttention(r.job, syncedAt, now)).length;
              const open = !!filter || openGroups.has(key);
              return (
                <Panel key={key} className="overflow-hidden">
                  <h3>
                    <button
                      type="button"
                      onClick={() => toggleGroup(key)}
                      aria-expanded={open}
                      disabled={!!filter}
                      className="w-full flex items-center justify-between gap-3 px-4 py-3 min-h-[56px] text-left"
                    >
                      <span className="min-w-0">
                        <span className="text-[17px] font-semibold text-[var(--text)]">{label}</span>
                        <span className="ml-2 text-[14px] text-[var(--text-2)]">
                          {plural(all.length, "töö", "tööd")} · {bad === 0 ? "kõik korras" : `${bad} ${bad === 1 ? "vajab" : "vajavad"} pilku`}
                        </span>
                      </span>
                      {!filter && <ChevronDown className={`w-5 h-5 shrink-0 text-[var(--text-2)] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />}
                    </button>
                  </h3>
                  {open && (
                    <>
                      <div className="hidden md:grid grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-x-4 px-4 py-2 border-t border-[var(--line)] text-[13px] uppercase tracking-wide text-[var(--text-2)]">
                        <span>Töö</span><span>Ajakava</span><span>Viimati</span><span>Järgmine</span><span className="w-[92px]">Seis</span>
                      </div>
                      <ul className="border-t border-[var(--line)]">
                        {shown.map(({ job, state }) => {
                          const k = keyOf(job);
                          return (
                            <JobRow
                              key={k}
                              job={job}
                              state={state}
                              now={now}
                              open={expanded === k}
                              onToggle={() => setExpanded((e) => (e === k ? null : k))}
                              actions={actions}
                            />
                          );
                        })}
                      </ul>
                    </>
                  )}
                </Panel>
              );
            })}
            {rows.length === 0 && !fetchError && (
              <p className="text-[15px] text-[var(--text-2)]">Ühtegi cron-tööd pole sünkitud.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
