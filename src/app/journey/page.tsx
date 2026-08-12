"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  CircleDashed,
  FileText,
  RefreshCw,
  X,
} from "lucide-react";
import { Panel, SectionHeader, Eyebrow, EmptyState, Skeleton } from "@/components/ui/kit";

// ── Types ─────────────────────────────────────────────────
interface SessionRow { id: string; title: string }
interface TraceEvent {
  type?: string;
  role?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string;
    toolCalls?: { name?: string; arguments?: unknown }[];
    toolName?: string;
    toolCallId?: string;
  } | null;
  toolCallId?: string;
  toolName?: string;
  model?: string;
  usage?: { tokens?: number };
  error?: string;
  kind?: string;
  status?: string;
}

function fmtTime(ts?: string) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function kindLabel(ev: TraceEvent): string {
  if (ev.type === "tool" || ev.toolCallId) return "🛠 tööriist";
  if (ev.type === "assistant" || ev.role === "assistant") return "🤖 agent";
  if (ev.role === "user") return "👤 kasutaja";
  if (ev.error) return "❌ viga";
  if (ev.kind) return ev.kind;
  return "samm";
}

function evTitle(ev: TraceEvent): string {
  const m = ev.message;
  const toolName = m?.toolName || ev.toolName || m?.toolCalls?.[0]?.name;
  if (toolName) return `Tööriist: ${toolName}`;
  if (ev.error) return ev.error.slice(0, 120);
  if (ev.model) return `Mudel: ${ev.model}`;
  const content = m?.content ?? "";
  if (typeof content === "string" && content.trim()) {
    return content.trim().slice(0, 140) + (content.length > 140 ? "…" : "");
  }
  return "(tühi samm)";
}

// ── Secret redaction + export ─────────────────────────────
// Redact credential-like patterns before any export (Julian's "safe
// transparency"): API keys, bearer tokens, URLs with embedded passwords.
const REDACT_PATTERNS: RegExp[] = [
  /(sk-[A-Za-z0-9_-]{8,})/g,
  /(ghp_[A-Za-z0-9]{8,})/g,
  /(github_pat_[A-Za-z0-9_]{8,})/g,
  /(sbp_[A-Za-z0-9]{8,})/g,
  /(sbp_oauth_[A-Za-z0-9]{8,})/g,
  /(GOCSPX-[A-Za-z0-9_-]{8,})/g,
  /(AIza[A-Za-z0-9_-]{10,})/g,
  /(AKIA[A-Z0-9]{16})/g,
  /(Bearer\s+)[A-Za-z0-9._-]{8,}/gi,
  /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/g,
  /(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  /(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._+\/=]{8,}/gi,
  /(token["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi,
  /(secret["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi,
  /(password["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi,
];

function redactString(s: string): string {
  let out = s;
  for (const re of REDACT_PATTERNS) {
    out = out.replace(re, (m, ...groups) => {
      // Preserve prefixes (e.g. "Bearer ", "key=", url user:) and mask the rest.
      const prefix = groups.slice(0, -2).find((g) => typeof g === "string" && g.length > 0) || "";
      return prefix + "***";
    });
  }
  return out;
}

// Recursively redact every string in a cloned structure — nested fields,
// tool arguments, results, metadata, headers all get scrubbed.
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

function exportJourney(trace: TraceEvent[], sessionId: string, format: "md" | "json") {
  if (format === "json") {
    const safe = redactDeep(JSON.parse(JSON.stringify(trace)));
    const blob = new Blob([JSON.stringify({ sessionId, events: safe }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `journey-${sessionId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } else {
    const lines = trace.map((ev, i) => {
      const title = redactString(evTitle(ev));
      const time = fmtTime(ev.timestamp);
      const tag = ev.error ? "❌" : "•";
      return `${tag} **${time || `samm ${i + 1}`}** — ${title}`;
    });
    const md = `# Teekond: ${redactString(sessionId)}\n\n${lines.join("\n")}\n`;
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `journey-${sessionId}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

// ── Journey Map panel ─────────────────────────────────────
export default function JourneyPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const r = await fetch("/api/hermes/journey");
      if (r.ok) {
        const d = await r.json();
        setSessions(d.sessions ?? []);
        setSyncedAt(d.syncedAt ?? null);
      }
    } catch { /* offline */ }
    setLoadingList(false);
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  const openSession = async (id: string) => {
    setSelected(id);
    setLoadingTrace(true);
    setTrace([]);
    const isActive = () => { let active = true; return { check: () => active, cancel: () => { active = false; } }; };
    const guard = isActive();
    // Try the cache first
    try {
      const cached = await fetch(`/api/hermes/journey?sessionId=${encodeURIComponent(id)}`);
      if (cached.ok) {
        const cd = await cached.json();
        if (cd.trace?.length) {
          if (guard.check()) { setTrace(cd.trace); setLoadingTrace(false); }
          return;
        }
      }
    } catch { /* continue to fetch */ }
    // Queue a fresh fetch on the bridge
    try {
      await fetch("/api/hermes/journey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      });
    } catch { /* ignore */ }
    // Poll for the trace (bridge takes a few seconds); only apply if this
    // session is still the selected one.
    let tries = 0;
    const iv = setInterval(async () => {
      tries += 1;
      try {
        const r = await fetch(`/api/hermes/journey?sessionId=${encodeURIComponent(id)}`);
        if (r.ok) {
          const d = await r.json();
          if (d.trace?.length && guard.check()) {
            setTrace(d.trace);
            setLoadingTrace(false);
            clearInterval(iv);
          }
        }
      } catch { /* keep polling */ }
      if (tries >= 20) { if (guard.check()) setLoadingTrace(false); clearInterval(iv); }
    }, 3000);
  };

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <div className="hq-rise pt-4 pb-8 flex items-end justify-between gap-4">
        <div>
          <Eyebrow>Teekonna kaart</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
            Journey Map
          </h1>
        </div>
        <div className="flex items-center gap-2.5">
          {syncedAt && (
            <span className="num text-[11px] text-[var(--text-3)]">
              sünkroonitud {new Date(syncedAt).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button type="button" onClick={loadList} aria-label="Värskenda" className="btn-ghost inline-flex items-center justify-center w-9 h-9">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        {/* Session list */}
        <div className="lg:col-span-1">
          <Panel className="p-2">
            {loadingList ? (
              <div className="p-4 space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
            ) : sessions.length === 0 ? (
              <EmptyState icon={<Activity className="w-6 h-6" />} title="Sessioone pole veel" hint="Kui Hermes on tööd teinud, ilmuvad sessioonid siia." />
            ) : (
              <div className="flex flex-col">
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => openSession(s.id)}
                    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors ${
                      selected === s.id ? "bg-white/[0.07] text-[var(--text)]" : "text-[var(--text-2)] hover:bg-white/[0.03]"
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: selected === s.id ? "var(--accent)" : "var(--text-3)" }} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12.5px] font-medium truncate">{s.title || s.id}</span>
                      <span className="block num text-[10.5px] text-[var(--text-3)] truncate">{s.id}</span>
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-[var(--text-3)] shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* Trace view */}
        <div className="lg:col-span-2">
          <Panel className="p-5">
            {!selected ? (
              <EmptyState icon={<CircleDashed className="w-6 h-6" />} title="Vali sessioon vasakult" hint="Näed agenti kogu teekonda: sõnumid, tööriistad, mudelivahetused, vead — iga samm." />
            ) : loadingTrace ? (
              <div className="space-y-3 py-6">
                <Skeleton className="h-10" /><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" />
                <p className="text-[12px] text-[var(--text-3)] text-center pt-2">Laen teekonda…</p>
              </div>
            ) : trace.length === 0 ? (
              <EmptyState icon={<CircleDashed className="w-6 h-6" />} title="Teekonda pole veel" hint="Proovi uuesti mõne sekundi pärast." />
            ) : (
              <div className="flex flex-col">
                <div className="flex items-center gap-2 mb-4">
                  <Eyebrow>Teekond</Eyebrow>
                  <span className="num text-[10.5px] text-[var(--text-3)]">{trace.length} sammu</span>
                  <span className="flex-1" />
                  {selected && (
                    <>
                      <button type="button" onClick={() => exportJourney(trace, selected, "md")}
                        className="text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-[var(--line)] text-[var(--text-2)] hover:text-[var(--text)] hover:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] transition-colors">
                        Ekspordi .md
                      </button>
                      <button type="button" onClick={() => exportJourney(trace, selected, "json")}
                        className="text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-[var(--line)] text-[var(--text-2)] hover:text-[var(--text)] hover:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] transition-colors">
                        Ekspordi .json
                      </button>
                    </>
                  )}
                </div>
                <div className="relative flex flex-col">
                  {trace.map((ev, i) => (
                    <div key={ev.uuid || i} className="relative flex gap-3 pb-3">
                      {/* timeline rail */}
                      {i < trace.length - 1 && (
                        <span className="absolute left-[7px] top-5 bottom-0 w-px bg-[var(--line)]" />
                      )}
                      <span className="relative z-10 mt-1.5 w-[15px] h-[15px] rounded-full shrink-0 flex items-center justify-center"
                        style={{ background: "var(--surface-2)", border: "1px solid var(--line)" }}>
                        <span className="w-[5px] h-[5px] rounded-full" style={{ background: ev.error ? "var(--down)" : "var(--accent)" }} />
                      </span>
                      <div className="flex-1 min-w-0 rounded-lg border border-[var(--line)] bg-white/[0.02] px-3 py-2">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-3)]">{kindLabel(ev)}</span>
                          <span className="num text-[10px] text-[var(--text-4)] ml-auto">{fmtTime(ev.timestamp)}</span>
                        </div>
                        <p className="text-[12.5px] leading-snug text-[var(--text-2)] break-words">{evTitle(ev)}</p>
                        {ev.error && (
                          <p className="mt-1 text-[11px] text-[var(--down)] break-words">⚠ {ev.error.slice(0, 200)}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
