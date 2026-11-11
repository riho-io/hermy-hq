"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Zap, Pause, Play, Clock } from "lucide-react";
import { Panel, SectionHeader, Button, Eyebrow } from "@/components/ui/kit";
import type { CronJob } from "@/app/api/hermes/crons/route";

type ReqState = { id: string; status: string; error: string | null };

const PRESETS = ["raport", "hoiatus", "vait"] as const;
const TERMINAL = new Set(["done", "failed", "rejected"]);
const POLL_MS = 10_000;

function ago(d: string | null): string {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (Number.isNaN(diff)) return "—";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just praegu";
  if (m < 60) return `${m} min tagasi`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h tagasi`;
  return `${Math.floor(h / 24)} p tagasi`;
}

function when(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleString("et-EE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function reqLabel(r: ReqState): { text: string; tone: string } {
  switch (r.status) {
    case "queued":
    case "approved":
      return { text: "ootel", tone: "var(--text-2)" };
    case "awaiting_approval":
      return { text: "ootab kinnitust", tone: "var(--warn)" };
    case "running":
      return { text: "käib", tone: "var(--accent)" };
    case "done":
      return { text: "tehtud", tone: "var(--up)" };
    case "failed":
      return { text: `viga: ${(r.error || "tundmatu").slice(0, 160)}`, tone: "var(--down)" };
    case "rejected":
      return { text: "tagasi lükatud", tone: "var(--text-3)" };
    default:
      return { text: r.status, tone: "var(--text-2)" };
  }
}

export function CronPanel({ jobs, syncedAt, onDone }: { jobs: CronJob[]; syncedAt: string | null; onDone: () => void }) {
  const [reqs, setReqs] = useState<Record<string, ReqState>>({});
  const [schedules, setSchedules] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Source of truth for reads outside render; every write goes through commitReqs so ref and state never drift.
  const reqsRef = useRef(reqs);
  const commitReqs = useCallback((next: Record<string, ReqState>) => {
    reqsRef.current = next;
    setReqs(next);
  }, []);
  const pollAbort = useRef<AbortController | null>(null);
  useEffect(() => () => pollAbort.current?.abort(), []);

  const send = async (job: CronJob, body: Record<string, string>) => {
    setBusy(job.id);
    setErrors((e) => ({ ...e, [job.id]: "" }));
    try {
      const r = await fetch("/api/hermes/crons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: job.id, profile: job.profile, ...body }),
      });
      const j = (await r.json().catch(() => ({}))) as { request?: { id: string; status: string; error: string | null }; error?: string };
      if (!r.ok || !j.request) {
        setErrors((e) => ({ ...e, [job.id]: j.error ? `Päring ebaõnnestus: ${j.error}` : "Päring ebaõnnestus." }));
        return;
      }
      const q = j.request;
      commitReqs({ ...reqsRef.current, [job.id]: { id: q.id, status: q.status, error: q.error ?? null } });
    } catch {
      setErrors((e) => ({ ...e, [job.id]: "Päring ebaõnnestus." }));
    } finally {
      setBusy(null);
    }
  };

  const pollOnce = useCallback(async () => {
    const open = Object.values(reqsRef.current).filter((r) => !TERMINAL.has(r.status));
    if (open.length === 0) return;
    pollAbort.current?.abort(); // a slow previous tick must not land after this one
    const ctrl = new AbortController();
    pollAbort.current = ctrl;
    try {
      const ids = open.slice(0, 20).map((r) => r.id).join(","); // route caps ?ids= at 20
      const r = await fetch(`/api/hermes/requests?ids=${encodeURIComponent(ids)}`, { signal: ctrl.signal });
      if (!r.ok) return;
      const { requests } = (await r.json()) as { requests: { id: string; status: string; error: string | null }[] };
      const byId = new Map(requests.map((q) => [q.id, q]));
      const prev = reqsRef.current; // read after the await: send() may have added a request meanwhile
      const next = { ...prev };
      let changed = false;
      let finished = false;
      for (const [jobId, cur] of Object.entries(prev)) {
        const q = byId.get(cur.id);
        if (q && q.status !== cur.status) {
          next[jobId] = { id: cur.id, status: q.status, error: q.error ?? null };
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
    const iv = setInterval(pollOnce, POLL_MS);
    return () => clearInterval(iv);
  }, [hasOpen, pollOnce]);

  return (
    <>
      <SectionHeader
        label="Cron · graafikud"
        title="Korduvad tööd"
        action={<span className="num text-[11px] text-[var(--text-3)]">sünkroonitud {ago(syncedAt)}</span>}
      />
      <Panel className="p-5">
        <div className="flex items-center justify-between mb-3">
          <Eyebrow>graafikud</Eyebrow>
          <span className="num text-[10.5px] text-[var(--text-3)]">
            {jobs.length} töö{jobs.length === 1 ? "" : "d"}
          </span>
        </div>
        {jobs.length === 0 ? (
          <p className="text-[13px] text-[var(--text-3)] py-6 text-center">Graafikuid pole veel.</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {jobs.map((j) => {
              const active = j.status === "active";
              const req = reqs[j.id];
              const label = req ? reqLabel(req) : null;
              const sched = schedules[j.id] ?? "";
              const disabled = busy === j.id;
              const failed = j.lastStatus != null && j.lastStatus !== "ok" && j.lastStatus !== "success";
              const err = errors[j.id];
              return (
                <div key={j.id} className="rounded-[10px] border border-[var(--line)] bg-[var(--surface-2)] p-3 flex flex-col gap-2.5">
                  <div className="flex items-start gap-2.5">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: active ? "var(--up)" : "var(--text-3)" }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-[var(--text)] truncate">{j.name || j.id}</p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 num text-[11px] text-[var(--text-3)]">
                        <span className="text-[var(--text-2)]">{active ? "aktiivne" : "peatatud"}</span>
                        <span>{j.schedule}</span>
                        <span>profiil {j.profile}</span>
                      </div>
                    </div>
                  </div>

                  <div className="num text-[11.5px] text-[var(--text-3)] space-y-0.5">
                    <p>järgmine jooks: <span className="text-[var(--text-2)]">{active ? when(j.nextRun) : "—"}</span></p>
                    <p>
                      viimane: <span className="text-[var(--text-2)]">{ago(j.lastRun)}</span>
                      {j.lastStatus && (
                        <span style={{ color: failed ? "var(--down)" : "var(--up)" }}> · {failed ? "viga" : "korras"}</span>
                      )}
                      {j.failureStreak > 1 && <span> · {j.failureStreak} järjest</span>}
                    </p>
                    {failed && j.lastError && (
                      <p className="text-[var(--down)] break-words">{j.lastError.slice(0, 200)}</p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {active ? (
                      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => send(j, { op: "pause" })}>
                        <Pause className="w-3.5 h-3.5" /> Peata
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => send(j, { op: "resume" })}>
                        <Play className="w-3.5 h-3.5" /> Jätka
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" disabled={disabled} onClick={() => send(j, { op: "run" })}>
                      <Zap className="w-3.5 h-3.5" /> Käivita kohe
                    </Button>
                    <label className="flex items-center gap-1.5 text-[12px] text-[var(--text-3)] ml-auto">
                      Telegram
                      <select
                        value={j.telegram}
                        disabled={disabled}
                        onChange={(e) => {
                          if (e.target.value !== j.telegram) send(j, { op: "deliver", preset: e.target.value });
                        }}
                        className="bg-[var(--surface-1)] text-[12px] text-[var(--text)] px-2 py-1 rounded-[8px] border border-[var(--line)] outline-none"
                      >
                        {j.telegram === "muu" && <option value="muu" disabled>muu</option>}
                        {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </label>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      value={sched}
                      onChange={(e) => setSchedules((s) => ({ ...s, [j.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter" && sched.trim()) { e.preventDefault(); send(j, { op: "schedule", schedule: sched.trim() }); } }}
                      placeholder="Uus ajakava (nt 0 9 * * 1)"
                      className="flex-1 min-w-0 bg-transparent num text-[12px] text-[var(--text)] placeholder:text-[var(--text-3)] px-2.5 py-1.5 rounded-[8px] border border-[var(--line)] outline-none focus:border-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
                    />
                    <Button variant="ghost" size="sm" disabled={disabled || !sched.trim()} onClick={() => send(j, { op: "schedule", schedule: sched.trim() })}>
                      <Clock className="w-3.5 h-3.5" /> Saada kinnitamiseks
                    </Button>
                  </div>

                  {(label || err) && (
                    <p className="text-[12px] break-words" style={{ color: err ? "var(--down)" : label?.tone }} aria-live="polite">
                      {err || label?.text}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </>
  );
}
