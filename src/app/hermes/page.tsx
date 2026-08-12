"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Send,
  RefreshCw,
  Check,
  X,
  Pencil,
  Inbox,
  Clock,
  Zap,
  Activity as ActivityIcon,
  LayoutGrid,
  Pause,
  Play,
  Target,
  Cpu,
} from "lucide-react";
import {
  Panel,
  SectionHeader,
  Button,
  Pill,
  EmptyState,
  Skeleton,
  Eyebrow,
} from "@/components/ui/kit";
import { HermesDispatches } from "@/components/hermes-dispatches";
import { HermesRuns } from "@/components/hermes-runs";

// ── Types ─────────────────────────────────────────────────
type ReqStatus =
  | "queued"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "done"
  | "failed"
  | "rejected";

interface Req {
  id: string;
  origin: string;
  kind: string;
  title: string;
  prompt: string | null;
  sideEffecting: boolean;
  status: ReqStatus;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

type EvLevel = "info" | "up" | "warn" | "down";
interface Ev {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  agent: string | null;
  level: EvLevel;
  createdAt: string;
}

interface Task {
  id: string;
  board: string;
  title: string;
  assignee: string | null;
  status: string;
  priority: number | null;
  result: string | null;
  syncedAt: string;
}

interface Health {
  online: boolean;
  gateway: string | null;
  detail: string | null;
  lastSeen: string | null;
}

// ── Helpers ───────────────────────────────────────────────
function timeAgo(d: string | null): string {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (Number.isNaN(diff)) return "—";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ── Task board column order ───────────────────────────────
const COLUMN_ORDER = [
  "triage",
  "todo",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const;

function normStatus(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}
function columnFor(status: string): string {
  const k = normStatus(status);
  for (const c of COLUMN_ORDER) if (k.includes(c)) return c;
  if (k.includes("progress") || k.includes("doing")) return "running";
  if (k.includes("complete")) return "done";
  return "triage";
}
function columnTone(col: string): "neutral" | "up" | "down" | "warn" | "accent" {
  if (col === "done") return "up";
  if (col === "running") return "accent";
  if (col === "blocked") return "down";
  if (col === "review") return "warn";
  return "neutral";
}
const COLUMN_LABEL: Record<string, string> = {
  triage: "Uus",
  todo: "Ootel",
  ready: "Valmis",
  running: "Töös",
  review: "Ülevaatusel",
  blocked: "Blokeeritud",
  done: "Valmis",
};

function levelColor(l: EvLevel): string {
  if (l === "up") return "var(--up)";
  if (l === "down") return "var(--down)";
  if (l === "warn") return "var(--warn)";
  return "var(--text-3)";
}

// ── Health chip ───────────────────────────────────────────
function HealthChip({ health }: { health: Health | null }) {
  const online = !!health?.online;
  const color = online ? "var(--up)" : "var(--warn)";
  return (
    <div
      className="flex items-center gap-2 rounded-full border px-3 py-1.5"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 22%, transparent)`,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
      }}
    >
      <span className="relative flex w-1.5 h-1.5">
        {online && (
          <span
            className="absolute inline-flex h-full w-full rounded-full animate-ping"
            style={{ background: "color-mix(in srgb, var(--up) 60%, transparent)" }}
          />
        )}
        <span
          className="relative inline-flex w-1.5 h-1.5 rounded-full"
          style={{ background: color }}
        />
      </span>
      <span className="text-[12px] font-semibold">
        {online ? "Ühendatud" : "Maas · bridge ootel"}
      </span>
      {health?.lastSeen && (
        <span className="num text-[10.5px] text-[var(--text-3)]">
          {timeAgo(health.lastSeen)}
        </span>
      )}
    </div>
  );
}

// ── Dispatch bar ──────────────────────────────────────────
function DispatchBar({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const [side, setSide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4000);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const submit = async () => {
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/hermes/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "oneshot", title, sideEffecting: side }),
      });
      if (r.ok) {
        setText("");
        flash(
          side
            ? "Saadetud kinnitussisendisse — ootan sinu otsust."
            : "Järjekorda pandud Hermesele."
        );
        onDone();
      } else {
        flash("Saatmine ebaõnnestus. Proovi uuesti.");
      }
    } catch {
      flash("Saatmine ebaõnnestus. Proovi uuesti.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="p-5">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
          }}
          placeholder="Küsi või ütle Hermesele, mida teha…"
          className="flex-1 min-w-0 bg-transparent text-[14px] text-[var(--text)] placeholder:text-[var(--text-3)] px-3.5 py-2.5 rounded-[10px] border border-[var(--line)] focus:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] outline-none transition-colors"
        />
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setSide((s) => !s)}
            aria-pressed={side}
            className="flex items-center gap-2 select-none"
          >
            <span
              className="relative inline-flex h-[18px] w-[32px] rounded-full transition-colors"
              style={{
                background: side
                  ? "color-mix(in srgb, var(--warn) 55%, transparent)"
                  : "var(--surface-2)",
                border: "1px solid var(--line)",
              }}
            >
              <span
                className="absolute top-[1px] h-[14px] w-[14px] rounded-full bg-[var(--text)] transition-all"
                style={{ left: side ? "15px" : "1px" }}
              />
            </span>
            <span className="text-[12px] font-medium text-[var(--text-2)]">
              külgmõjuga?
            </span>
          </button>
          <Button variant="primary" onClick={submit} disabled={busy || !text.trim()}>
            <Send className="w-3.5 h-3.5" />
            Saada
          </Button>
        </div>
      </div>
      {toast && (
        <p className="mt-3 text-[12.5px] text-[var(--text-2)] flex items-center gap-1.5">
          <Check className="w-3.5 h-3.5" style={{ color: "var(--up)" }} />
          {toast}
        </p>
      )}
    </Panel>
  );
}

// ── Goal Mode ─────────────────────────────────────────────
// Send a long-running autonomous goal to Hermes (bridge runs it with a
// longer timeout). Mirrors Julian's "goal mode": one prompt, hours of work.
function GoalModeCard({ onDone }: { onDone: () => void }) {
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 6000);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const submit = async () => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/hermes/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Goal mode is the most autonomous action — it MUST go through the
        // approval gate before the bridge will run it.
        body: JSON.stringify({ kind: "goal", sideEffecting: true, title: goal.trim().slice(0, 200), prompt: goal.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setGoal("");
        flash("Eesmärk saadetud kinnitussisendisse — kinnita see, siis hakkab Hermes tööle!");
      } else {
        flash("Saatmine ebaõnnestus. Proovi uuesti.");
      }
      onDone();
    } catch {
      flash("Saatmine ebaõnnestus. Proovi uuesti.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="p-5">
      <div className="flex items-center gap-2.5 mb-3">
        <Target className="w-4 h-4" style={{ color: "var(--accent)" }} />
        <Eyebrow>Eesmärgirežiim</Eyebrow>
        <Pill tone="accent">goal mode</Pill>
      </div>
      <p className="text-[12.5px] text-[var(--text-3)] mb-3">
        Anna üks suur eesmärk — Hermes töötab selle kallal tunde iseseisvalt. Eesmärk läheb esmalt kinnitussisendisse (turvalisus!).
      </p>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={3}
        placeholder="Nt: uuri ja koosta terve nädala sisu meie publikule…"
        className="w-full bg-transparent text-[13.5px] text-[var(--text)] placeholder:text-[var(--text-3)] px-3.5 py-2.5 rounded-[10px] border border-[var(--line)] focus:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] outline-none transition-colors resize-y"
      />
      <div className="flex items-center justify-between mt-3">
        <span className="text-[11px] text-[var(--text-3)] num">kuni 30 min autonoomset tööd</span>
        <Button variant="primary" onClick={submit} disabled={busy || !goal.trim()}>
          <Zap className="w-3.5 h-3.5" />
          {busy ? "Saadan…" : "Käivita eesmärk"}
        </Button>
      </div>
      {toast && (
        <p className="mt-3 text-[12.5px] text-[var(--text-2)] flex items-center gap-1.5">
          <Check className="w-3.5 h-3.5" style={{ color: "var(--up)" }} />
          {toast}
        </p>
      )}
    </Panel>
  );
}

// ── Model switching ───────────────────────────────────────
// Read + switch the Hermes model from the dashboard (2 clicks, like Julian's
// "manage tab"). Talks to /api/hermes/model which shells out to the CLI.
function ModelSwitcher() {
  const [current, setCurrent] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/hermes/model");
      if (r.ok) {
        const d = await r.json();
        setCurrent(d.model || "");
        setModels(d.models || []);
      }
    } catch { /* bridge may be offline */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flash = (msg: string) => {
    setToast(msg);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 5000);
  };

  const switchTo = async (m: string) => {
    if (busy || m === current) return;
    setBusy(true);
    try {
      const r = await fetch("/api/hermes/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m }),
      });
      if (r.ok) {
        setCurrent(m);
        flash(`Mudel vahetatud: ${m}`);
      } else {
        flash("Vahetamine ebaõnnestus.");
      }
    } catch {
      flash("Vahetamine ebaõnnestus.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="p-5">
      <div className="flex items-center gap-2.5 mb-3">
        <Cpu className="w-4 h-4" style={{ color: "var(--accent)" }} />
        <Eyebrow>Mudeli vahetamine</Eyebrow>
      </div>
      <p className="text-[12.5px] text-[var(--text-3)] mb-3">
        Praegune: <span className="num text-[var(--text)]">{current || "—"}</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {models.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => switchTo(m)}
            disabled={busy || m === current}
            className={`px-2.5 py-1.5 rounded-md text-[11px] font-medium num transition-colors ${
              m === current
                ? "bg-[var(--surface-2)] text-[var(--text)] border border-[var(--line)]"
                : "text-[var(--text-2)] hover:text-[var(--text)] border border-[var(--line)] hover:border-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
            }`}
          >
            {m.split("/").pop()}
          </button>
        ))}
      </div>
      {toast && (
        <p className="mt-3 text-[12.5px] text-[var(--text-2)] flex items-center gap-1.5">
          <Check className="w-3.5 h-3.5" style={{ color: "var(--up)" }} />
          {toast}
        </p>
      )}
    </Panel>
  );
}

// ── Approval inbox card ───────────────────────────────────
function InboxCard({ req, onAction }: { req: Req; onAction: () => void }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(req.title);
  const [draftPrompt, setDraftPrompt] = useState(req.prompt ?? "");

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await fetch(`/api/hermes/requests/${req.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      onAction();
    } catch {
      /* leave card in place on failure */
    } finally {
      setBusy(false);
      setEditing(false);
    }
  };

  return (
    <Panel className={`p-5 ${busy ? "opacity-50 pointer-events-none" : ""}`}>
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone="neutral">{req.kind}</Pill>
          {req.sideEffecting && <Pill tone="warn">side-effecting</Pill>}
        </div>
        <span className="num text-[10.5px] text-[var(--text-3)] shrink-0 mt-1">
          {timeAgo(req.createdAt)}
        </span>
      </div>

      {editing ? (
        <div className="space-y-2.5">
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            className="w-full bg-transparent text-[14px] font-medium text-[var(--text)] px-3 py-2 rounded-[8px] border border-[var(--line)] outline-none focus:border-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
          />
          <textarea
            value={draftPrompt}
            onChange={(e) => setDraftPrompt(e.target.value)}
            rows={3}
            className="w-full bg-transparent text-[13px] text-[var(--text-2)] px-3 py-2 rounded-[8px] border border-[var(--line)] outline-none focus:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] resize-y"
          />
        </div>
      ) : (
        <>
          <h3 className="text-[15px] font-medium text-[var(--text)] leading-snug">
            {req.title}
          </h3>
          {req.prompt && (
            <p className="mt-1.5 text-[13px] text-[var(--text-2)] leading-snug line-clamp-3">
              {req.prompt}
            </p>
          )}
        </>
      )}

      <div className="flex items-center gap-2 mt-4">
        {editing ? (
          <>
            <button
              type="button"
              onClick={() =>
                patch({ action: "edit", title: draftTitle.trim(), prompt: draftPrompt })
              }
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors"
              style={{
                color: "var(--accent)",
                border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                background: "color-mix(in srgb, var(--accent) 10%, transparent)",
              }}
            >
              <Check className="w-3.5 h-3.5" />
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraftTitle(req.title);
                setDraftPrompt(req.prompt ?? "");
              }}
              className="btn-ghost inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-medium"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => patch({ action: "approve" })}
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors"
              style={{
                color: "var(--up)",
                border: "1px solid color-mix(in srgb, var(--up) 30%, transparent)",
                background: "color-mix(in srgb, var(--up) 10%, transparent)",
              }}
            >
              <Check className="w-3.5 h-3.5" />
              Approve
            </button>
            <button
              type="button"
              onClick={() => patch({ action: "reject" })}
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors text-[var(--text-2)] hover:text-[var(--down)]"
              style={{ border: "1px solid var(--line)" }}
            >
              <X className="w-3.5 h-3.5" />
              Reject
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors text-[var(--text-2)] hover:text-[var(--text)]"
              style={{ border: "1px solid var(--line)" }}
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </button>
          </>
        )}
      </div>
    </Panel>
  );
}

// ── Task board ────────────────────────────────────────────
function TaskBoard({
  tasks,
  total,
  lastSync,
}: {
  tasks: Task[];
  total: number;
  lastSync: string | null;
}) {
  const groups: Record<string, Task[]> = {};
  for (const t of tasks) {
    const col = columnFor(t.status);
    (groups[col] ||= []).push(t);
  }
  const cols = COLUMN_ORDER.filter((c) => groups[c]?.length);

  return (
    <>
      <SectionHeader
        label="Ülesandelaud"
        title="Hermese kanban"
        action={
          <div className="flex items-center gap-3">
            <span className="num text-[12px] text-[var(--text-2)]">{total} kokku</span>
            <span className="num text-[11px] text-[var(--text-3)]">
              sünkroonitud {timeAgo(lastSync)}
            </span>
          </div>
        }
      />
      {tasks.length === 0 ? (
        <Panel className="p-2">
          <EmptyState
            icon={<LayoutGrid className="w-6 h-6" />}
            title="Laual pole ülesandeid"
            hint="Saadetud töö ja sünkroonitud kanban-kaardid ilmuvad siia."
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cols.map((col) => {
            const tone = columnTone(col);
            return (
              <div key={col} className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between px-1">
                  <Eyebrow>{COLUMN_LABEL[col]}</Eyebrow>
                  <span className="num text-[11px] text-[var(--text-3)]">
                    {groups[col].length}
                  </span>
                </div>
                <div className="flex flex-col gap-2.5">
                  {groups[col]
                    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
                    .map((t) => (
                      <div
                        key={t.id}
                        className="panel p-3.5"
                        style={{
                          borderLeft: `2px solid color-mix(in srgb, ${
                            tone === "neutral" ? "var(--text-3)" : `var(--${tone})`
                          } 55%, transparent)`,
                        }}
                      >
                        <p className="text-[13px] text-[var(--text)] leading-snug line-clamp-2">
                          {t.title}
                        </p>
                        <div className="flex items-center gap-2 mt-2.5">
                          {t.assignee && (
                            <span className="num text-[10.5px] text-[var(--text-3)]">
                              {t.assignee}
                            </span>
                          )}
                          {t.priority != null && t.priority > 0 && (
                            <span className="num text-[10.5px] text-[var(--text-3)] ml-auto">
                              P{t.priority}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Cron / schedules ──────────────────────────────────────
type CronJob = {
  id: string; status: string; name: string; schedule: string;
  nextRun: string | null; lastRun: string | null; lastResult: string | null;
  deliver: string | null; skills: string | null; script: string | null; mode: string | null;
};
function CronPanel({ jobs, syncedAt, onDone }: { jobs: CronJob[]; syncedAt: string | null; onDone: () => void }) {
  const [schedule, setSchedule] = useState("");
  const [prompt, setPrompt] = useState("");
  const [runName, setRunName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const post = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      const r = await fetch("/api/hermes/crons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setNote(r.ok ? ok : "Päring ebaõnnestus.");
      if (r.ok) onDone();
    } catch {
      setNote("Päring ebaõnnestus.");
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    if (!schedule.trim() || !prompt.trim()) return;
    post(
      { op: "create", schedule: schedule.trim(), prompt: prompt.trim() },
      "Graafik saadetud Hermesele."
    ).then(() => {
      setSchedule("");
      setPrompt("");
    });
  };
  const runNow = () => {
    if (!runName.trim()) return;
    post({ op: "run", name: runName.trim() }, "Kohene käivitus saadetud Hermesele.").then(() =>
      setRunName("")
    );
  };

  return (
    <>
      <SectionHeader
        label="Cron · graafikud"
        title="Korduvad tööd"
        action={
          <span className="num text-[11px] text-[var(--text-3)]">
            sünkroonitud {timeAgo(syncedAt)}
          </span>
        }
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Schedules */}
        <Panel className="p-5">
          <div className="flex items-center justify-between mb-3">
            <Eyebrow>graafikud</Eyebrow>
            <span className="num text-[10.5px] text-[var(--text-3)]">
              {jobs.length} töö{jobs.length === 1 ? "" : "d"}
            </span>
          </div>
          {jobs.length === 0 ? (
            <p className="text-[13px] text-[var(--text-3)] py-6 text-center">
              Graafikuid pole veel.
            </p>
          ) : (
            <div className="flex flex-col gap-2 max-h-[440px] overflow-auto -mx-1 px-1">
              {jobs.map((j) => {
                const active = j.status === "active";
                return (
                  <div key={j.id} className="rounded-[10px] border border-[var(--line)] bg-[var(--surface-2)] p-3">
                    <div className="flex items-start gap-2.5">
                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: active ? "var(--up)" : "var(--text-3)" }} title={j.status} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-[var(--text)] truncate">{j.name || j.id}</p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 num text-[11px] text-[var(--text-3)]">
                          <span className="text-[var(--text-2)]">{j.schedule}</span>
                          {j.nextRun && <span>next {timeAgo(j.nextRun)}</span>}
                          {j.deliver && <span>→ {j.deliver.split(":")[0]}</span>}
                          {j.skills && <span>{j.skills}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button title="Run now" disabled={busy} onClick={() => post({ op: "run", id: j.id, name: j.name }, "Run-now sent.")} className="p-1.5 rounded-md text-[var(--text-3)] hover:text-[var(--accent)] hover:bg-[var(--surface-1)] transition-colors">
                          <Zap className="w-3.5 h-3.5" />
                        </button>
                        {active ? (
                          <button title="Pause" disabled={busy} onClick={() => post({ op: "pause", id: j.id, name: j.name }, "Pause sent.")} className="p-1.5 rounded-md text-[var(--text-3)] hover:text-[var(--warn)] hover:bg-[var(--surface-1)] transition-colors">
                            <Pause className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button title="Resume" disabled={busy} onClick={() => post({ op: "resume", id: j.id, name: j.name }, "Resume sent.")} className="p-1.5 rounded-md text-[var(--text-3)] hover:text-[var(--up)] hover:bg-[var(--surface-1)] transition-colors">
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        {/* Controls */}
        <Panel className="p-5">
          <div className="space-y-4">
            <div>
              <Eyebrow className="!mb-2 block">Uus graafik</Eyebrow>
              <div className="space-y-2.5">
                <input
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  placeholder="Graafik (nt 0 9 * * 1)"
                  className="w-full bg-transparent num text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)] px-3 py-2 rounded-[8px] border border-[var(--line)] outline-none focus:border-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
                />
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={2}
                  placeholder="Käsk — mida peaks Hermes sellel intervallil tegema?"
                  className="w-full bg-transparent text-[13px] text-[var(--text-2)] placeholder:text-[var(--text-3)] px-3 py-2 rounded-[8px] border border-[var(--line)] outline-none focus:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] resize-y"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={create}
                  disabled={busy || !schedule.trim() || !prompt.trim()}
                >
                  <Clock className="w-3.5 h-3.5" />
                  Loo graafik
                </Button>
              </div>
            </div>

            <div className="rule" />

            <div>
              <Eyebrow className="!mb-2 block">Käivita kohe</Eyebrow>
              <div className="flex items-center gap-2.5">
                <input
                  value={runName}
                  onChange={(e) => setRunName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runNow(); } }}
                  placeholder="Töö nimi"
                  className="flex-1 min-w-0 bg-transparent text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)] px-3 py-2 rounded-[8px] border border-[var(--line)] outline-none focus:border-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
                />
                <Button variant="ghost" size="sm" onClick={runNow} disabled={busy || !runName.trim()}>
                  <Zap className="w-3.5 h-3.5" />
                  Käivita kohe
                </Button>
              </div>
            </div>

            {note && (
              <p className="text-[12px] text-[var(--text-2)] flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5" style={{ color: "var(--up)" }} />
                {note}
              </p>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}

// ── Activity feed ─────────────────────────────────────────
function ActivityFeed({ events }: { events: Ev[] }) {
  return (
    <>
      <SectionHeader label="Tegevus" title="Hiljutised sündmused" />
      {events.length === 0 ? (
        <Panel className="p-2">
          <EmptyState
            icon={<ActivityIcon className="w-6 h-6" />}
            title="Hiljutist tegevust pole"
            hint="Hermese ja tema agentide sündmused voogavad siia."
          />
        </Panel>
      ) : (
        <Panel className="p-2">
          <div className="divide-y divide-[var(--line)]">
            {events.map((e) => (
              <div key={e.id} className="flex items-start gap-3 px-3.5 py-3">
                <span
                  className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: levelColor(e.level) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] font-medium text-[var(--text)] leading-snug truncate">
                      {e.title}
                    </p>
                    <span className="num text-[10.5px] text-[var(--text-3)] shrink-0 ml-auto">
                      {timeAgo(e.createdAt)}
                    </span>
                  </div>
                  {e.detail && (
                    <p className="mt-0.5 text-[12.5px] text-[var(--text-2)] leading-snug line-clamp-2">
                      {e.detail}
                    </p>
                  )}
                  {e.agent && (
                    <span className="num text-[10.5px] text-[var(--text-3)] mt-1 inline-block">
                      {e.agent}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}

// ── Main ──────────────────────────────────────────────────
export default function HermesPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [inbox, setInbox] = useState<Req[]>([]);
  const [pending, setPending] = useState(0);
  const [events, setEvents] = useState<Ev[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskTotal, setTaskTotal] = useState(0);
  const [taskSync, setTaskSync] = useState<string | null>(null);
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [cronSync, setCronSync] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [h, reqs, act, tk, cr] = await Promise.all([
      getJSON<Health>("/api/hermes/health"),
      getJSON<{ requests: Req[]; pending: number }>(
        "/api/hermes/requests?status=awaiting_approval&take=50"
      ),
      getJSON<{ events: Ev[] }>("/api/hermes/activity?take=40"),
      getJSON<{ tasks: Task[]; counts: Record<string, number>; total: number; lastSync: string }>(
        "/api/hermes/tasks"
      ),
      getJSON<{ jobs: CronJob[]; syncedAt: string }>("/api/hermes/crons"),
    ]);
    if (h) setHealth(h);
    if (reqs) {
      setInbox(reqs.requests ?? []);
      setPending(reqs.pending ?? reqs.requests?.length ?? 0);
    }
    if (act) setEvents(act.events ?? []);
    if (tk) {
      setTasks(tk.tasks ?? []);
      setTaskTotal(tk.total ?? tk.tasks?.length ?? 0);
      setTaskSync(tk.lastSync ?? null);
    }
    if (cr) {
      setJobs(cr.jobs ?? []);
      setCronSync(cr.syncedAt ?? null);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 8000);
    return () => clearInterval(iv);
  }, [load]);

  const manualRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <>
      <div className="relative z-10 w-full mx-auto pb-16">
        {/* Header */}
        <div className="hq-rise pt-4 pb-8 flex items-end justify-between gap-4">
          <div>
            <Eyebrow>Agendi mootor</Eyebrow>
            <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
              Hermes
            </h1>
          </div>
          <div className="flex items-center gap-2.5">
            <HealthChip health={health} />
            <button
              type="button"
              onClick={manualRefresh}
              aria-label="Refresh"
              className="btn-ghost inline-flex items-center justify-center w-9 h-9"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Dispatch */}
        <div className="hq-rise">
          <DispatchBar onDone={load} />
        </div>

        {/* Goal Mode + Model switching — Julian-style extras */}
        <div className="mt-5 grid grid-cols-1 xl:grid-cols-2 gap-5 items-start hq-rise">
          <GoalModeCard onDone={load} />
          <ModelSwitcher />
        </div>

        {/* Dispatches — what you've sent Hermes + live status/results */}
        <section className="mt-12">
          <HermesDispatches />
        </section>

        {/* Approval inbox */}
        <section className="mt-12">
          <SectionHeader
            label="Kinnitussisend"
            title="Ootab kinnitust"
            action={
              pending > 0 ? (
                <Pill tone="warn">{pending} ootel</Pill>
              ) : (
                <span className="num text-[11px] text-[var(--text-3)]">puhas</span>
              )
            }
          />
          {!loaded ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Skeleton className="h-40" />
              <Skeleton className="h-40" />
            </div>
          ) : inbox.length === 0 ? (
            <Panel className="p-2">
              <EmptyState
                icon={<Inbox className="w-6 h-6" />}
                title="Kinnitust ootavaid asju pole."
                hint="Külgmõjuga saadetised jõuavad siia ühe klõpsuga kinnitamiseks."
              />
            </Panel>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {inbox.map((req) => (
                <InboxCard key={req.id} req={req} onAction={load} />
              ))}
            </div>
          )}
        </section>

        {/* Task board */}
        <section className="mt-12">
          {!loaded ? (
            <>
              <SectionHeader label="Ülesandelaud" title="Hermese kanban" />
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <Skeleton className="h-48" />
                <Skeleton className="h-48" />
                <Skeleton className="h-48" />
              </div>
            </>
          ) : (
            <TaskBoard tasks={tasks} total={taskTotal} lastSync={taskSync} />
          )}
        </section>

        {/* Cron / schedules */}
        <section className="mt-12">
          {!loaded ? (
            <>
              <SectionHeader label="Cron · graafikud" title="Korduvad tööd" />
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Skeleton className="h-56" />
                <Skeleton className="h-56" />
              </div>
            </>
          ) : (
            <CronPanel jobs={jobs} syncedAt={cronSync} onDone={load} />
          )}
        </section>

        {/* Activity feed */}
        <section className="mt-12">
          {!loaded ? (
            <>
              <SectionHeader label="Tegevus" title="Hiljutised sündmused" />
              <Skeleton className="h-64" />
            </>
          ) : (
            <ActivityFeed events={events} />
          )}
        </section>

        {/* Observability — runs & usage */}
        <section className="mt-12">
          <HermesRuns />
        </section>
      </div>
    </>
  );
}
