"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Plus, RefreshCw, FileText, Trash2, Check, Undo2, AlertTriangle, ChevronRight } from "lucide-react";
import { Panel, Pill, Button, Eyebrow, EmptyState } from "@/components/ui/kit";

interface Group { id: string; name: string; address: string | null; keywords: string[]; sortOrder: number }
interface Bill {
  id: string; groupId: string | null; source: string; status: "new" | "review" | "paid" | "ignored";
  supplier: string | null; amountCents: number | null; currency: string; dueDate: string | null;
  reference: string | null; iban: string | null; payUrl: string | null; notes: string | null;
  subject: string | null; ignoreReason: string | null; hasFile: boolean;
}

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Tallinn" });
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const money = (c: number | null, cur: string) =>
  c === null ? "—" : `${(c / 100).toLocaleString("et-EE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur === "EUR" ? "€" : cur}`;
const fmtDate = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "tähtajata");

// payUrl comes from untrusted email text: only https links are shown, with the host visible.
function payHost(u: string): string | null {
  try {
    const p = new URL(u);
    return p.protocol === "https:" ? p.hostname : null;
  } catch {
    return null;
  }
}

function urgency(b: Bill): { label: string; tone: "neutral" | "warn" | "down" } {
  if (b.status === "paid") return { label: "makstud", tone: "neutral" };
  if (!b.dueDate) return { label: "tähtajata", tone: "neutral" };
  const n = days(today(), b.dueDate);
  if (n < 0) return { label: `${-n} p hilinenud`, tone: "down" };
  if (n === 0) return { label: "täna", tone: "down" };
  if (n <= 3) return { label: `${n} p`, tone: "warn" };
  return { label: `${n} p`, tone: "neutral" };
}

// 0 overdue, 1 due today, 2 due later, 3 no due date, 4 paid/other. Overdue/today only for open bills.
function billRank(b: Bill, todayIso: string): number {
  if (b.status === "paid" || b.status === "ignored") return 4;
  if (!b.dueDate) return 3;
  const n = days(todayIso, b.dueDate);
  return n < 0 ? 0 : n === 0 ? 1 : 2;
}
const isOverdue = (b: Bill, todayIso: string) => billRank(b, todayIso) === 0;

function sortBills(bills: Bill[], todayIso: string): Bill[] {
  return [...bills].sort((a, b) => {
    const r = billRank(a, todayIso) - billRank(b, todayIso);
    if (r !== 0) return r;
    return (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
  });
}

// Argo cron "Arved: postkastid -> Hermy HQ" (argo_arved.py), profile default.
const ARVED_CRON_ID = "26aebfdcd850";

// Keeps the sorted order: a supplier sits where its most urgent bill is.
function bySupplier(items: Bill[]): { name: string; items: Bill[] }[] {
  const out = new Map<string, { name: string; items: Bill[] }>();
  for (const b of items) {
    const name = b.supplier ?? b.subject ?? "(nimeta)";
    const k = name.trim().toLowerCase();
    if (!out.has(k)) out.set(k, { name, items: [] });
    out.get(k)!.items.push(b);
  }
  return [...out.values()];
}

const ROW_GRID ="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 items-center px-2 sm:grid-cols-[minmax(0,1fr)_170px_110px_340px] sm:gap-x-4";
const GROUP_COLORS = ["var(--accent)", "var(--up)", "var(--text-2)"];

function RowHead() {
  return (
    <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_170px_110px_340px] gap-x-4 px-2 pb-2 text-[10.5px] uppercase tracking-[0.08em] text-[var(--text-4)]">
      <span>Väljastaja</span>
      <span>Tähtaeg</span>
      <span className="text-right">Summa</span>
      <span aria-hidden />
    </div>
  );
}

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Viga ${res.status}`);
}

export default function ArvedPage() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPaid, setShowPaid] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);

  const [syncing, setSyncing] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch("/api/bills", { cache: "no-store" });
      if (!res.ok) throw new Error(`Viga ${res.status}`);
      const j = await res.json();
      setBills(j.bills);
      setGroups(j.groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Laadimine ebaõnnestus");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Mail is read on Argo, not here: queue a run of the Argo bills cron through the existing
  // cron.run queue (no approval; executor polls every 2 min), then reload quietly until the
  // run has had time to post new bills.
  const syncMail = async () => {
    setError(null);
    setSyncing("Argo kontrollib postkaste…");
    try {
      const res = await fetch("/api/hermes/crons", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "run", id: ARVED_CRON_ID, profile: "default" }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Viga ${res.status}`);
      const { request } = await res.json();
      const start = Date.now();
      let launchedAt: number | null = null;
      while (Date.now() - start < 6 * 60_000 && (launchedAt === null || Date.now() - launchedAt < 2 * 60_000)) {
        await new Promise((r) => setTimeout(r, 15_000));
        if (launchedAt === null) {
          const r = await fetch(`/api/hermes/requests?ids=${request.id}`, { cache: "no-store" });
          const row = r.ok ? (await r.json()).requests?.[0] : null;
          if (row?.status === "failed") throw new Error(`Postkastide kontroll ebaõnnestus: ${row.error ?? "tundmatu viga"}`);
          if (row?.status === "done") { launchedAt = Date.now(); setSyncing("Postkastid loetakse, uued arved tulevad…"); }
        }
        await load(true);
      }
      if (launchedAt === null) setError("Argo ei võtnud päringut 6 min jooksul vastu.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Viga");
    } finally {
      setSyncing(null);
      load(true);
    }
  };

  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Viga"); }
    load();
  };

  const todayIso = today();
  const review = sortBills(bills.filter((b) => b.status === "review"), todayIso);
  const blocks = useMemo(() => {
    const list = bills.filter((b) => b.status !== "review" && b.status !== "ignored" && (showPaid || b.status !== "paid"));
    const byGroup = (id: string | null) => sortBills(list.filter((b) => b.groupId === id), todayIso);
    return [...groups.map((g) => ({ key: g.id, group: g as Group | null, items: byGroup(g.id) })),
            { key: "none", group: null as Group | null, items: byGroup(null) }];
  }, [bills, groups, showPaid, todayIso]);
  const ignored = bills.filter((b) => b.status === "ignored");
  const openLabel = (list: Bill[]) => {
    const nw = list.filter((b) => b.status === "new");
    const eur = nw.filter((b) => b.currency === "EUR");
    const other = nw.length - eur.length;
    return { eur, text: `${eur.length} maksmata${other > 0 ? ` + ${other} muus vääringus` : ""}` };
  };

  // All blocks together: open EUR bills (status "new"); review rows are not counted until fixed.
  const allOpen = openLabel(bills).eur;
  const total = {
    count: allOpen.length,
    sum: allOpen.reduce((s, b) => s + (b.amountCents ?? 0), 0),
    late: allOpen.filter((b) => isOverdue(b, todayIso)).length,
  };

  const overview = [
    ...(review.length > 0 ? [{ id: "review", name: "Vaata üle", color: "var(--warn)", count: review.length, sum: null as number | null, late: review.filter((b) => isOverdue(b, todayIso)).length }] : []),
    ...blocks.filter((bl) => bl.group || bl.items.length > 0 || groups.length === 0).map((bl, i) => {
      const ol = openLabel(bl.items);
      return { id: bl.key, name: bl.group ? bl.group.name : "Sorteerimata", color: bl.group ? GROUP_COLORS[i % GROUP_COLORS.length] : "var(--text-3)", count: ol.eur.length, sum: ol.eur.reduce((s, b) => s + (b.amountCents ?? 0), 0) as number | null, late: bl.items.filter((b) => isOverdue(b, todayIso)).length };
    }),
  ];

  const renderRow = (b: Bill, tint: string) => {
    const u = urgency(b);
    const paid = b.status === "paid";
    const host = b.payUrl ? payHost(b.payUrl) : null;
    const name = b.supplier ?? b.subject ?? "(nimeta)";
    const rank = billRank(b, todayIso);
    const rowEdge = rank === 0 ? "var(--down)" : rank === 1 ? "var(--warn)" : null;
    const rowBg = rank === 0 ? "color-mix(in srgb, var(--down) 12%, transparent)" : rank === 1 ? "color-mix(in srgb, var(--warn) 10%, transparent)" : "transparent";
    const rowHover = rank === 0 ? "color-mix(in srgb, var(--down) 20%, transparent)" : rank === 1 ? "color-mix(in srgb, var(--warn) 18%, transparent)" : `color-mix(in srgb, ${tint} 6%, transparent)`;
    return (
      <div key={b.id} style={{ "--row": rowBg, "--row-h": rowHover, ...(rowEdge ? { boxShadow: `inset 3px 0 0 ${rowEdge}` } : {}) } as React.CSSProperties} className={`${ROW_GRID} py-3 border-t border-[var(--line-strong)] first:border-t-0 transition-colors bg-[var(--row)] hover:bg-[var(--row-h)] ${paid ? "opacity-[0.55]" : ""}`}>
        <div className="min-w-0">
          <div className="text-[14px] text-[var(--text)]">{b.supplier ?? b.subject ?? "(nimeta)"}</div>
          <div className="text-[12px] text-[var(--text-2)]">
            {[b.reference && `viide ${b.reference}`, b.iban, b.source === "manual" && "käsitsi"].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:col-start-2 sm:row-start-auto row-start-2">
          <span className="text-[12.5px] text-[var(--text-2)]">{fmtDate(b.dueDate)}</span>
          <Pill tone={u.tone}>{u.label}</Pill>
        </div>
        <div className={`num text-[14px] ${rank === 0 ? "text-[var(--down)] font-medium" : "text-[var(--text)]"} text-right col-start-2 row-start-1 sm:col-start-3 sm:row-start-auto ${paid ? "line-through" : ""}`}>{money(b.amountCents, b.currency)}</div>
        <div className="col-span-2 row-start-3 sm:col-span-1 sm:col-start-4 sm:row-start-auto flex flex-wrap sm:flex-nowrap items-center justify-end gap-1.5">
        <select
          aria-label={`Plokk: ${name}`}
          value={b.groupId ?? ""}
          onChange={(e) => act(() => call("PATCH", "/api/bills", { id: b.id, groupId: e.target.value || null }))}
          className="rounded-md border border-[var(--line)] bg-transparent px-2 py-1 text-[12.5px] text-[var(--text-2)]"
        >
          <option value="">Sorteerimata</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        {b.hasFile && (
          <a href={`/api/bills/file?id=${encodeURIComponent(b.id)}`} target="_blank" rel="noopener noreferrer" aria-label={`Ava PDF: ${name}`} className="btn-ghost inline-flex w-8 h-8 items-center justify-center">
            <FileText className="w-4 h-4" />
          </a>
        )}
        {b.payUrl && host && (
          <a href={b.payUrl} target="_blank" rel="noopener noreferrer" className="text-[12.5px] text-[var(--text-2)] underline">Ava link ({host})</a>
        )}
        {b.status === "paid" ? (
          <button type="button" aria-label={`Taasta: ${name}`} className="btn-ghost w-8 h-8 inline-flex items-center justify-center"
            onClick={() => act(() => call("PATCH", "/api/bills", { id: b.id, status: "new" }))}><Undo2 className="w-4 h-4" /></button>
        ) : (
          // Native button (kit Button has no aria-label prop); same classes as Button variant="primary".
          <button type="button" aria-label={`Makstud: ${name}`} className="inline-flex items-center justify-center gap-1.5 font-medium px-4 py-2 text-[13px] btn-primary"
            onClick={() => act(() => call("PATCH", "/api/bills", { id: b.id, status: "paid" }))}>
            <Check className="w-4 h-4" /> Makstud
          </button>
        )}
        <button type="button" aria-label={`Kustuta: ${name}`} className="btn-ghost w-8 h-8 inline-flex items-center justify-center"
          onClick={() => { if (window.confirm(`Kustutada arve "${b.supplier ?? b.subject ?? ""}"?`)) act(() => call("DELETE", `/api/bills?id=${encodeURIComponent(b.id)}`)); }}>
          <Trash2 className="w-4 h-4" />
        </button>
        </div>
      </div>
    );
  };

  // One summary row per supplier with 2+ bills; the arrow opens its bills. Single bills stay plain rows.
  const renderSupplier = (blockKey: string, name: string, list: Bill[], tint: string) => {
    if (list.length === 1) return renderRow(list[0], tint);
    const id = `${blockKey}:${name.toLowerCase()}`;
    const isOpen = open.has(id);
    const ol = openLabel(list);
    const sum = ol.eur.reduce((s, b) => s + (b.amountCents ?? 0), 0);
    const late = list.filter((b) => isOverdue(b, todayIso)).length;
    const first = list[0];
    const u = urgency(first);
    return (
      <div key={id} className="border-t border-[var(--line-strong)] first:border-t-0">
        <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? "Sulge" : "Ava"} arved: ${name}`}
          onClick={() => setOpen((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          className={`${ROW_GRID} w-full py-3 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)]`}>
          <div className="min-w-0 flex items-center gap-2">
            <ChevronRight aria-hidden className={`w-4 h-4 shrink-0 text-[var(--text-3)] transition-transform ${isOpen ? "rotate-90" : ""}`} />
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-[var(--text)]">{name}</div>
              <div className="text-[12px] text-[var(--text-2)]">{ol.text}{late > 0 ? ` · ${late} hilinenud` : ""}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:col-start-2 row-start-2 sm:row-start-auto">
            <span className="text-[12.5px] text-[var(--text-2)]">{fmtDate(first.dueDate)}</span>
            <Pill tone={u.tone}>{u.label}</Pill>
          </div>
          <div className={`num text-[14px] font-semibold text-right col-start-2 row-start-1 sm:col-start-3 sm:row-start-auto ${late > 0 ? "text-[var(--down)]" : "text-[var(--text)]"}`}>{money(sum, "EUR")}</div>
          <span aria-hidden className="hidden sm:block" />
        </button>
        {isOpen && <div className="pl-4 sm:pl-6 pb-2">{list.map((b) => renderRow(b, tint))}</div>}
      </div>
    );
  };

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <div className="hq-rise pt-4 pb-6 flex items-end justify-between gap-4">
        <div>
          <Eyebrow>Isiklikud</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">Arved</h1>
          <p className="text-[13.5px] text-[var(--text-3)] mt-2">
            {openLabel(bills).text} · {review.length} vajab ülevaatust
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={syncMail} disabled={syncing !== null} aria-label="Too uued arved meilidest" title="Too uued arved meilidest" className="btn-ghost inline-flex items-center justify-center w-9 h-9 disabled:opacity-60"><RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} /></button>
          <Button variant="primary" onClick={() => setAdding((v) => !v)}><Plus className="w-4 h-4" /> Lisa arve</Button>
        </div>
      </div>

      {syncing && <div role="status" className="mb-4 text-[13px] text-[var(--text-3)]">{syncing}</div>}
      {error && <div role="alert" className="mb-4 rounded-md border border-[var(--down)] px-3 py-2 text-[13px] text-[var(--down)]">{error}</div>}

      {adding && (
        <AddBill groups={groups} onDone={() => { setAdding(false); load(); }} onError={setError} />
      )}

      {review.length > 0 && (
        <div id="plokk-review" className="scroll-mt-24 mb-6"><Panel className="p-5 sm:p-6" style={{ background: "var(--surface-2)", boxShadow: "inset 4px 0 0 var(--warn)", borderColor: "color-mix(in srgb, var(--warn) 35%, var(--line-strong))" }}>
          <div className="flex items-center gap-2 mb-3 -mx-5 -mt-5 sm:-mx-6 sm:-mt-6 px-5 sm:px-6 py-3.5 rounded-t-[calc(var(--r-lg)-1px)] border-b" style={{ background: "color-mix(in srgb, var(--warn) 18%, transparent)", borderBottomColor: "color-mix(in srgb, var(--warn) 35%, transparent)" }}>
            <AlertTriangle className="w-4 h-4 text-[var(--warn)]" />
            <h2 className="text-[20px] font-semibold text-[var(--warn)]">Vaata üle ({review.length})</h2>
          </div>
          <p className="text-[12.5px] text-[var(--text-3)] mb-3 pb-3 border-b border-[var(--line-strong)]">Summa või tähtaeg puudub või lugemine ebaõnnestus. Parandamiseks kustuta ja lisa käsitsi, või jäta; tähtajaga ridadele tuleb meeldetuletus ka siin.</p>
          <RowHead />
          {review.map((b) => renderRow(b, "var(--warn)"))}
        </Panel></div>
      )}

      <nav aria-label="Plokkide ülevaade" className="mb-6 flex flex-wrap gap-2">
        {total.count > 0 && (
          <div className="flex items-center gap-2.5 rounded-[var(--r-lg)] border border-[var(--line-strong)] bg-[var(--surface-2)] px-3.5 py-2">
            <span className="text-[13px] font-semibold text-[var(--text)]">Maksta kokku</span>
            <span className="num text-[13px] text-[var(--text)]">{total.count} · {money(total.sum, "EUR")}</span>
            {total.late > 0 && <Pill tone="down">{total.late} hilinenud</Pill>}
          </div>
        )}
        {overview.map((o) => (
          <a key={o.id} href={`#plokk-${o.id}`} style={{ background: `color-mix(in srgb, ${o.color} 14%, transparent)`, borderColor: `color-mix(in srgb, ${o.color} 40%, transparent)` }} className="flex items-center gap-2.5 rounded-[var(--r-lg)] border px-3.5 py-2 transition-[filter] hover:brightness-110">
            <span aria-hidden className="w-2 h-2 rounded-full" style={{ background: o.color }} />
            <span className="text-[13px] font-medium text-[var(--text)]">{o.name}</span>
            <span className="num text-[12px] text-[var(--text-3)]">{o.sum === null ? o.count : `${o.count} · ${money(o.sum, "EUR")}`}</span>
            {o.late > 0 && <Pill tone="down">{o.late} hilinenud</Pill>}
          </a>
        ))}
      </nav>

      <div className="mt-6 flex items-center gap-3">
        <button type="button" onClick={() => setShowPaid((v) => !v)} className="text-[12.5px] text-[var(--text-3)] underline">
          {showPaid ? "Peida makstud" : "Näita makstud"}
        </button>
        <button type="button" onClick={() => setAddingGroup((v) => !v)} className="text-[12.5px] text-[var(--text-3)] underline">Uus plokk</button>
      </div>
      {addingGroup && <AddGroup onDone={() => { setAddingGroup(false); load(); }} onError={setError} />}


      <div className="grid gap-6">
        {loading && bills.length === 0 && <div className="text-[13px] text-[var(--text-3)]">Laen…</div>}
        {blocks.map(({ key, group, items }, i) => {
          if (!group && items.length === 0 && groups.length > 0) return null;
          const ol = openLabel(items);
          const late = items.filter((b) => isOverdue(b, todayIso)).length;
          const sum = ol.eur.reduce((s, b) => s + (b.amountCents ?? 0), 0);
          const color = group ? GROUP_COLORS[i % GROUP_COLORS.length] : "var(--text-3)";
          return (
            <div key={key} id={`plokk-${key}`} className="scroll-mt-24">
              <Panel className="p-5 sm:p-6" style={{ background: "var(--surface-2)", boxShadow: `inset 4px 0 0 ${color}`, borderColor: `color-mix(in srgb, ${color} 35%, var(--line-strong))` }}>
                <div className="flex flex-wrap items-start justify-between gap-3 -mx-5 -mt-5 sm:-mx-6 sm:-mt-6 px-5 sm:px-6 py-4 mb-2 rounded-t-[calc(var(--r-lg)-1px)] border-b" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, borderBottomColor: `color-mix(in srgb, ${color} 35%, transparent)` }}>
                  <div className="min-w-0">
                    <h2 className="text-[20px] font-semibold" style={{ color: group ? color : "var(--text-2)" }}>{group ? group.name : "Sorteerimata"}</h2>
                    {group?.address && <div className="text-[12.5px] text-[var(--text-3)] mt-0.5">{group.address}</div>}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <div className="num text-[13px] text-[var(--text)] flex flex-wrap items-center justify-end gap-2">
                      {late > 0 && <Pill tone="down">{late} hilinenud</Pill>}
                      <span>{ol.text} · <span style={{ color }}>{money(sum, "EUR")}</span></span>
                    </div>
                    {group && (
                      <button type="button" aria-label={`Kustuta plokk: ${group.name}`} className="text-[12px] text-[var(--text-3)] underline"
                        onClick={() => { if (window.confirm(`Kustutada plokk "${group.name}"? Arved jäävad alles (Sorteerimata).`)) act(() => call("DELETE", `/api/bill-groups?id=${encodeURIComponent(group.id)}`)); }}>
                        Kustuta plokk
                      </button>
                    )}
                  </div>
                </div>
                {items.length === 0 ? <EmptyState title="Arveid ei ole" className="!py-6" /> : (
                  <>
                    <RowHead />
                    {bySupplier(items).map((s) => renderSupplier(key, s.name, s.items, color))}
                  </>
                )}
              </Panel>
            </div>
          );
        })}
      </div>

      {ignored.length > 0 && (
        <details className="mt-6 rounded-[var(--r-lg)] border border-[var(--line)] px-5 py-4 text-[12.5px] text-[var(--text-3)]">
          <summary className="cursor-pointer">Ignoreeritud kirjad ({ignored.length}): kontrolli, et ükski arve pole siin</summary>
          <ul className="mt-2 space-y-1">
            {ignored.map((b) => (
              <li key={b.id} className="flex items-center gap-3">
                <span className="flex-1 truncate">{b.subject ?? "(teema puudub)"}</span>
                <button type="button" className="underline" aria-label={`Tegelikult arve: ${b.subject ?? "(teema puudub)"}`} onClick={() => act(() => call("PATCH", "/api/bills", { id: b.id, status: "review" }))}>Tegelikult arve</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function AddBill({ groups, onDone, onError }: { groups: Group[]; onDone: () => void; onError: (m: string) => void }) {
  const [f, setF] = useState({ supplier: "", amount: "", dueDate: "", groupId: "", reference: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setF((p) => ({ ...p, [k]: value }));
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const supplier = f.supplier.trim();
    if (!supplier) return onError("Väljastaja on kohustuslik");
    const amount = f.amount.trim() === "" ? null : Number(f.amount.replace(",", "."));
    if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000)) {
      return onError("Summa peab olema 0–1 000 000");
    }
    setBusy(true);
    try {
      await call("POST", "/api/bills", {
        supplier, amount, dueDate: f.dueDate || null, groupId: f.groupId || null,
        reference: f.reference || null, notes: f.notes || null,
      });
      onDone();
    } catch (err) { onError(err instanceof Error ? err.message : "Viga"); }
    finally { setBusy(false); }
  };
  const inp = "rounded-md border border-[var(--line)] bg-transparent px-2.5 py-1.5 text-[13.5px] text-[var(--text)]";
  return (
    <form onSubmit={submit} className="mb-6 grid gap-3 sm:grid-cols-3">
      <input required aria-label="Väljastaja" className={inp} placeholder="Väljastaja" value={f.supplier} onChange={set("supplier")} maxLength={120} />
      <input aria-label="Summa €" className={inp} placeholder="Summa €" inputMode="decimal" value={f.amount} onChange={set("amount")} />
      <input className={inp} type="date" aria-label="Tähtaeg" value={f.dueDate} onChange={set("dueDate")} />
      <select className={inp} aria-label="Plokk" value={f.groupId} onChange={set("groupId")}>
        <option value="">Sorteerimata</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      <input aria-label="Viitenumber" className={inp} placeholder="Viitenumber" value={f.reference} onChange={set("reference")} maxLength={60} />
      <input aria-label="Märkus" className={inp} placeholder="Märkus" value={f.notes} onChange={set("notes")} maxLength={1000} />
      <div className="sm:col-span-3"><Button variant="primary" type="submit" disabled={busy}>Salvesta</Button></div>
    </form>
  );
}

function AddGroup({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [f, setF] = useState({ name: "", address: "", keywords: "" });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const name = f.name.trim();
    if (!name) return onError("Nimi on kohustuslik");
    const keywords = f.keywords.split(",").map((s) => s.trim()).filter(Boolean);
    const short = keywords.find((k) => k.length < 3);
    if (short) return onError(`Märksõna peab olema vähemalt 3 märki: ${short}`);
    if (keywords.length > 20) return onError("Märksõnu võib olla kuni 20");
    setBusy(true);
    try { await call("POST", "/api/bill-groups", { name, address: f.address || null, keywords }); onDone(); }
    catch (err) { onError(err instanceof Error ? err.message : "Viga"); }
    finally { setBusy(false); }
  };
  const inp = "rounded-md border border-[var(--line)] bg-transparent px-2.5 py-1.5 text-[13.5px] text-[var(--text)]";
  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-3">
      <input required aria-label="Ploki nimi" className={inp} placeholder="Nimi (nt Kodu)" value={f.name} onChange={(e) => { const v = e.target.value; setF((p) => ({ ...p, name: v })); }} maxLength={80} />
      <input aria-label="Aadress" className={inp} placeholder="Aadress" value={f.address} onChange={(e) => { const v = e.target.value; setF((p) => ({ ...p, address: v })); }} maxLength={200} />
      <input aria-label="Märksõnad komaga" className={inp} placeholder="Märksõnad komaga (aadress, kliendinr; min 3 märki)" value={f.keywords} onChange={(e) => { const v = e.target.value; setF((p) => ({ ...p, keywords: v })); }} />
      <div className="sm:col-span-3"><Button variant="primary" type="submit" disabled={busy}>Lisa plokk</Button></div>
    </form>
  );
}
