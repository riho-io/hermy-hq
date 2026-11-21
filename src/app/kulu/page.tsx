"use client";

// /kulu — "Kulu ja profiilid": what Hermes cost per profile and whether the number can be trusted.
// Data: GET /api/hermes/usage (session-protected), filled hourly by Argo's hermy_usage_sync.py.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, AlertTriangle } from "lucide-react";
import { Eyebrow, Panel, Skeleton } from "@/components/ui/kit";
import { ago, clock } from "@/lib/cron-status";
import {
  summarize, usageHealth, fmtUsd, fmtTokens, PERIOD_DAYS,
  type Period, type UsageResponse, type Attention,
} from "@/lib/usage-summary";

const DATA_POLL_MS = 60_000;
const WARN = "#f5a25b"; // same orange as /cronid, ≥4.5:1 on --surface-1

const PERIODS: { key: Period; label: string; phrase: string }[] = [
  { key: "today", label: "Täna", phrase: "Täna" },
  { key: "7d", label: "7 päeva", phrase: "Viimase 7 päeva" },
  { key: "30d", label: "30 päeva", phrase: "Viimase 30 päeva" },
];

const btn =
  "btn-ghost inline-flex items-center justify-center gap-2 min-h-[44px] px-4 text-[14px] font-medium disabled:opacity-40 disabled:pointer-events-none";

const shortModel = (m: string | null) => (m ? m.split("/").pop() ?? m : "—");
const dateFmt = new Intl.DateTimeFormat("et-EE", { timeZone: "Europe/Tallinn", day: "numeric", month: "short" });
const shortDate = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? "kuupäev teadmata" : `seis ${dateFmt.format(new Date(t))}`;
};

function Counter({ label, value, sub, warn = false }: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <Panel className="p-4 min-h-[104px]">
      <p className="text-[14px] font-medium text-[var(--text-2)]">{label}</p>
      <p className="mt-1 num text-[28px] sm:text-[32px] font-semibold" style={{ color: warn ? WARN : "var(--text)" }}>
        {value}
      </p>
      <p className="text-[14px] text-[var(--text-2)]">{sub}</p>
    </Panel>
  );
}

export default function KuluPage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<Period>("7d");
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const r = await fetch("/api/hermes/usage", { cache: "no-store", signal: ctrl.signal });
      if (!r.ok) {
        setFetchError(r.status === 401 ? "sessioon aegunud, logi uuesti sisse" : `HTTP ${r.status}`);
      } else {
        const j = (await r.json()) as Partial<UsageResponse>;
        if (!Array.isArray(j.days) || !Array.isArray(j.profiles)) throw new Error("vigane vastus");
        setData({ days: j.days, profiles: j.profiles, balance: j.balance ?? null, syncedAt: j.syncedAt ?? null });
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

  const syncedAt = data?.syncedAt ?? null;
  const hasData = !!data && (data.days.length > 0 || data.profiles.length > 0);
  const health = loaded ? usageHealth(fetchError, syncedAt, now, hasData) : { kind: "ok" as const };
  const s = useMemo(() => (data ? summarize(data.days, data.profiles, period, now) : null), [data, period, now]);

  // Stale data leads the list: every other item is only as current as the last sync.
  const items: (Attention | { kind: "stale"; text: string })[] = [
    ...(health.kind === "stale" ? [{ kind: "stale" as const, text: health.message }] : []),
    ...(s?.attention ?? []),
  ];

  const phrase = PERIODS.find((p) => p.key === period)!.phrase;
  const headline = !loaded
    ? "Laen…"
    : !s || (fetchError && !hasData)
      ? "Andmeid ei saa kätte."
      : !hasData
        ? "Kuluandmeid pole veel sünkitud."
        : s.totals.unpricedSessions > 0
          ? `${phrase} teada kulu ${fmtUsd(s.totals.costUsd)} — tegelik on suurem.`
          : `${phrase} kulu ${fmtUsd(s.totals.costUsd)}.`;

  const manualRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <div className="relative z-10 w-full max-w-5xl mx-auto pb-16 text-[14px]">
      <header className="hq-rise pt-4 pb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div className="min-w-0">
          <Eyebrow>Hermes · kulu ja profiilid</Eyebrow>
          <h1 className="mt-2 text-[28px] sm:text-[36px] font-semibold tracking-[-0.02em] text-[var(--text)]">{headline}</h1>
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
            background: `color-mix(in srgb, ${health.kind === "failed" ? "var(--down)" : WARN} 14%, transparent)`,
            border: `1px solid color-mix(in srgb, ${health.kind === "failed" ? "var(--down)" : WARN} 45%, transparent)`,
          }}
        >
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: health.kind === "failed" ? "var(--down)" : WARN }} aria-hidden />
          <p>{health.message}</p>
        </div>
      )}

      <div role="group" aria-label="Periood" className="mb-6 inline-flex rounded-[12px] border border-[var(--line)] p-1 gap-1">
        {PERIODS.map((p) => {
          const active = period === p.key;
          return (
            <button
              key={p.key}
              type="button"
              aria-pressed={active}
              onClick={() => setPeriod(p.key)}
              className="min-h-[44px] px-4 rounded-[9px] text-[14px] font-medium transition-colors"
              style={active ? { background: "var(--surface-2)", color: "var(--text)" } : { color: "var(--text-2)" }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {!loaded ? (
        <div className="space-y-4" aria-busy="true" aria-label="Laen">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}
          </div>
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      ) : !s ? null : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
            <Counter
              label="Teada kulu"
              value={fmtUsd(s.totals.costUsd)}
              sub={s.totals.subscriptionCostUsd > 0 ? `+ tellimus ~${fmtUsd(s.totals.subscriptionCostUsd)} (ei maksa juurde)` : "makstud API"}
            />
            <Counter
              label="Sessioonid ilma hinnata"
              value={String(s.totals.unpricedSessions)}
              sub={s.totals.unpricedSessions > 0 ? "kulu on alahinnatud" : "kõigil on hind"}
              warn={s.totals.unpricedSessions > 0}
            />
            <Counter label="Tokenid" value={fmtTokens(s.totals.tokens)} sub={`${s.totals.sessions} sessiooni`} />
            <Counter
              label="Konto saldo"
              value={data?.balance ? fmtUsd(data.balance.balanceUsd) : "—"}
              sub={data?.balance ? shortDate(data.balance.checkedAt) : "pole teada"}
            />
          </div>

          <section aria-labelledby="att-h" className="mb-8">
            <h2 id="att-h" className="text-[19px] font-semibold text-[var(--text)] mb-3">Vajab tähelepanu</h2>
            {items.length === 0 ? (
              <p className="text-[15px] text-[var(--text-2)]">Midagi ei vaja tähelepanu.</p>
            ) : (
              <ul className="space-y-2">
                {items.map((a, i) => (
                  <li key={`${a.kind}-${i}`}>
                    <Panel className="p-4 flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: a.kind === "idle" ? "var(--text-2)" : WARN }} aria-hidden />
                      <p className="text-[15px] text-[var(--text)] break-words">{a.text}</p>
                    </Panel>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="prof-h">
            <h2 id="prof-h" className="text-[19px] font-semibold text-[var(--text)] mb-3">
              Profiilid <span className="text-[14px] font-normal text-[var(--text-2)]">· {PERIOD_DAYS[period] === 1 ? "täna" : `${PERIOD_DAYS[period]} päeva`}</span>
            </h2>
            {s.rows.length === 0 ? (
              <p className="text-[15px] text-[var(--text-2)]">Ühtegi profiili pole sünkitud.</p>
            ) : (
              <Panel className="overflow-hidden">
                <div className="hidden md:grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_70px_90px_minmax(0,1.6fr)_90px] gap-x-4 px-4 py-2 text-[13px] uppercase tracking-wide text-[var(--text-2)]">
                  <span>Profiil</span>
                  <span>Mudel</span>
                  <span className="text-right">Cronid</span>
                  <span className="text-right">Sessioonid</span>
                  <span>Tokenid</span>
                  <span className="text-right">Kulu</span>
                </div>
                <ul>
                  {s.rows.map((r) => {
                    const pct = s.maxTokens > 0 ? Math.max(r.tokens > 0 ? 2 : 0, (r.tokens / s.maxTokens) * 100) : 0;
                    return (
                      <li
                        key={r.profile}
                        className="border-t border-[var(--line)] px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_70px_90px_minmax(0,1.6fr)_90px] md:items-center"
                      >
                        <span className="min-w-0">
                          <span className="block text-[15px] font-medium text-[var(--text)] truncate">{r.label}</span>
                          {r.alias && <span className="block text-[14px] text-[var(--text-2)] truncate">{r.alias}</span>}
                        </span>
                        <span className="min-w-0 text-right md:text-left text-[14px] text-[var(--text-2)] truncate">
                          <span className="num">{shortModel(r.model)}</span>
                          {r.subscription && " (tellimus)"}
                        </span>
                        <span className="text-[14px] text-[var(--text-2)] md:text-right">
                          <span className="md:hidden">Cronid </span>
                          <span className="num text-[var(--text)]">{r.cronEnabled}</span>
                          {r.cronCount !== r.cronEnabled && <span className="num">/{r.cronCount}</span>}
                        </span>
                        <span className="text-[14px] text-[var(--text-2)] text-right">
                          <span className="md:hidden">Sessioonid </span>
                          <span className="num text-[var(--text)]">{r.sessions}</span>
                          {r.unpricedSessions > 0 && <span style={{ color: WARN }}> · {r.unpricedSessions} ilma hinnata</span>}
                        </span>
                        <span className="col-span-2 md:col-span-1 flex items-center gap-3 min-w-0">
                          <span className="flex-1 h-2 rounded-full bg-[var(--surface-2)] overflow-hidden" aria-hidden>
                            <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                          </span>
                          <span className="num text-[14px] text-[var(--text)] w-[64px] text-right">{fmtTokens(r.tokens)}</span>
                        </span>
                        <span className="col-span-2 md:col-span-1 text-[14px] text-right">
                          <span className="md:hidden text-[var(--text-2)]">Kulu </span>
                          <span className="num text-[var(--text)]">
                            {r.subscription && r.costUsd === null ? "tellimus" : fmtUsd(r.costUsd)}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            )}
            <p className="mt-3 text-[14px] text-[var(--text-2)]">
              Kulu on Hermese enda hinnang (makstud API). Tellimusega profiilid ei maksa tokenite eest juurde. Sessioon loetakse päeva alla, mil see algas.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
