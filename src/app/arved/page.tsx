"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Plus, RefreshCw, FileText, Trash2, Check, Undo2, AlertTriangle, ChevronRight, ExternalLink, MoreHorizontal, Pencil } from "lucide-react";
import { Panel, Button, Eyebrow, EmptyState } from "@/components/ui/kit";

interface Group { id: string; name: string; address: string | null; keywords?: string[]; sortOrder: number; guestVisible: boolean }
interface Bill {
  id: string; groupId: string | null; source: string; status: "new" | "review" | "paid" | "ignored";
  supplier: string | null; amountCents: number | null; currency: string; dueDate: string | null;
  reference: string | null; iban: string | null; payUrl: string | null; notes: string | null;
  subject: string | null; ignoreReason: string | null; hasFile: boolean; paidAt: string | null; deletedAt?: string | null;
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
// Paid in the last month (paidAt, or due date for old rows without it): stays visible, in green.
const RECENT_PAID_DAYS = 31;
const isRecentPaid = (b: Bill, todayIso: string) => {
  if (b.status !== "paid") return false;
  const d = b.paidAt ? new Date(b.paidAt).toLocaleDateString("en-CA", { timeZone: "Europe/Tallinn" }) : b.dueDate;
  return d !== null && days(d, todayIso) <= RECENT_PAID_DAYS;
};

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

// Same columns for every row (single bill and supplier summary): name · due · amount · actions.
const COLS = "sm:grid-cols-[minmax(0,1fr)_210px_120px_148px]";
const ROW_GRID = `grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-center px-3 ${COLS} sm:gap-x-4`;
// Block colour is only a small solid dot in front of the name; surfaces stay neutral.
const GROUP_COLORS = ["var(--accent)", "var(--up)", "var(--text-2)"];
// Unticked blocks (block keys), per browser. Hidden ones are stored so a new block shows up by default.
const HIDDEN_BLOCKS_KEY = "arved.hiddenBlocks";
const ROW_HOVER = "hover:bg-[var(--surface-2)]";
const MENU_ITEM = "flex w-full items-center gap-2.5 rounded-md px-2.5 h-9 text-left text-[13px] whitespace-nowrap transition-colors hover:bg-[var(--surface-3)] focus-visible:bg-[var(--surface-3)]";

function RowHead() {
  return (
    <div className={`hidden sm:grid ${COLS} gap-x-4 px-3 pb-2 text-[12px] text-[var(--text-2)]`}>
      <span>Väljastaja</span>
      <span>Tähtaeg</span>
      <span className="text-right">Summa</span>
      <span aria-hidden />
    </div>
  );
}

// "⋯" menu: fixed-position so the panel never clips it; Esc / outside click / scroll close it,
// Esc returns focus to the trigger, Tab moves through the items.
function Menu({ label, children }: { label: string; children: ReactNode }) {
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback((refocus = true) => { setPos(null); if (refocus) btn.current?.focus(); }, []);
  const toggle = () => {
    if (pos) return close();
    const r = btn.current!.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    setPos(r.bottom + 240 > window.innerHeight ? { bottom: window.innerHeight - r.top + 6, right } : { top: r.bottom + 6, right });
  };
  useEffect(() => {
    if (!pos) return;
    box.current?.querySelector<HTMLElement>("a, button, select, input")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    const onMove = () => close(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [pos, close]);
  return (
    <>
      <button ref={btn} type="button" aria-label={label} aria-haspopup="true" aria-expanded={pos !== null} onClick={toggle}
        className="btn-ghost inline-flex w-8 h-8 shrink-0 items-center justify-center">
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {/* Portal to <body>: a transformed ancestor would otherwise turn `fixed` into a local box. */}
      {pos && createPortal(
        <div ref={box} role="group" aria-label={label} style={pos}
          // Picking a link/button or a new block closes the menu; toggling a checkbox keeps it open.
          onClick={(e) => { if ((e.target as HTMLElement).closest("a, button")) close(); }}
          onChange={(e) => { if ((e.target as HTMLElement).tagName === "SELECT") close(); }}
          onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node) && e.relatedTarget !== btn.current) close(false); }}
          className="elevated fixed z-50 min-w-[220px] max-w-[calc(100vw-16px)] p-1.5">
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Viga ${res.status}`);
}

export default function ArvedPage() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [deleted, setDeleted] = useState<Bill[]>([]); // newest deletion first; never in the sums or blocks
  const [showDeleted, setShowDeleted] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPaid, setShowPaid] = useState(false);
  // "bills_guest" (BILLS_GUEST_EMAILS) sees shared blocks and only the "Makstud" button. The API enforces it.
  const [role, setRole] = useState<"owner" | "bills_guest" | null>(null);
  const guest = role === "bills_guest";
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // bill id shown as a form
  const [addingGroup, setAddingGroup] = useState(false);

  const [syncing, setSyncing] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Read after mount (not in useState) so the server and first client render match.
  useEffect(() => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(HIDDEN_BLOCKS_KEY) ?? "[]");
      if (Array.isArray(v)) setHidden(new Set(v.filter((x): x is string => typeof x === "string")));
    } catch { /* storage blocked or bad value: show everything */ }
  }, []);
  const toggleBlock = (key: string) => {
    const next = new Set(hidden);
    if (!next.delete(key)) next.add(key);
    setHidden(next);
    try { localStorage.setItem(HIDDEN_BLOCKS_KEY, JSON.stringify([...next])); } catch { /* choice lasts until reload */ }
  };

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch("/api/bills", { cache: "no-store" });
      if (!res.ok) throw new Error(`Viga ${res.status}`);
      const j = await res.json();
      const all = j.bills as Bill[];
      setBills(all.filter((b) => !b.deletedAt));
      setDeleted(all.filter((b) => b.deletedAt).sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "")));
      setGroups(j.groups);
      setRole(j.role ?? null);
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
    const list = bills.filter((b) => b.status !== "review" && b.status !== "ignored" && (showPaid || b.status !== "paid" || isRecentPaid(b, todayIso)));
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

  // Ticked blocks together: open EUR bills (status "new"); review rows are not counted until fixed.
  const shownBills = bills.filter((b) => !hidden.has(b.groupId ?? "none"));
  const allOpen = openLabel(shownBills).eur;
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

  // Overdue / due today = amount in solid red; the day count stays a quiet grey note.
  const dueCell = (dueDate: string | null, u: { label: string }, emphasise: boolean) => (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0 row-start-2 sm:col-start-2 sm:row-start-auto">
      <span className="num text-[12.5px] text-[var(--text-2)] whitespace-nowrap">{fmtDate(dueDate)}</span>
      {u.label !== fmtDate(dueDate) && (
        <span className={`text-[12.5px] whitespace-nowrap ${emphasise ? "text-[var(--text)]" : "text-[var(--text-2)]"}`}>{u.label}</span>
      )}
    </div>
  );

  const renderRow = (b: Bill) => {
    if (editing === b.id && !guest) {
      return (
        <div key={b.id} className="px-3 pt-3 border-t border-[var(--line)] first:border-t-0">
          <BillForm bill={b} groups={groups} onError={setError} onCancel={() => setEditing(null)}
            onDone={() => { setEditing(null); setError(null); load(true); }} />
        </div>
      );
    }
    const u = urgency(b);
    const paid = b.status === "paid";
    const host = b.payUrl ? payHost(b.payUrl) : null;
    const name = b.supplier ?? b.subject ?? "(nimeta)";
    const rank = billRank(b, todayIso);
    const late = rank === 0 || rank === 1;
    const hasMenu = !guest || b.hasFile || (b.payUrl && host);
    return (
      <div key={b.id} className={`${ROW_GRID} py-3 border-t border-[var(--line)] first:border-t-0 rounded-md transition-colors ${ROW_HOVER}`}>
        <div className="min-w-0">
          <div className="text-[14px] text-[var(--text)] truncate">{name}</div>
          {(b.reference || b.iban || b.source === "manual") && (
            <div className="text-[12px] text-[var(--text-2)] truncate">
              {[b.reference && `viide ${b.reference}`, b.iban, b.source === "manual" && "käsitsi"].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
        {dueCell(b.dueDate, u, u.tone === "warn")}
        <div className={`num text-[14px] font-medium text-right whitespace-nowrap col-start-2 row-start-1 sm:col-start-3 sm:row-start-auto ${paid ? "text-[var(--up)]" : late ? "text-[var(--bill-late)]" : "text-[var(--text)]"}`}>{money(b.amountCents, b.currency)}</div>
        <div className="flex items-center justify-end gap-1.5 row-start-2 col-start-2 sm:col-start-4 sm:row-start-auto">
          {paid && guest ? (
            <span className="inline-flex items-center gap-1.5 h-8 text-[13px] text-[var(--up)]"><Check className="w-4 h-4" /> Makstud</span>
          ) : paid ? (
            <button type="button" aria-label={`Taasta: ${name}`} title="Taasta maksmata arveks" className="btn-ghost w-8 h-8 inline-flex items-center justify-center"
              onClick={() => act(() => call("PATCH", "/api/bills", { id: b.id, status: "new" }))}><Undo2 className="w-4 h-4" /></button>
          ) : (
            // Quiet outline button: fills only on hover / keyboard focus so amounts stay the brightest thing.
            <button type="button" aria-label={`Makstud: ${name}`}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-[var(--line-strong)] text-[13px] font-medium text-[var(--text)] transition-[background-color,color,border-color,transform] duration-150 ease-[var(--ease)] hover:bg-[var(--text)] hover:text-[var(--bg)] hover:border-[var(--text)] focus-visible:bg-[var(--text)] focus-visible:text-[var(--bg)] active:scale-[0.97] motion-reduce:active:scale-100"
              onClick={() => act(() => call("PATCH", "/api/bills", { id: b.id, status: "paid" }))}>
              <Check className="w-4 h-4" /> Makstud
            </button>
          )}
          {hasMenu ? (
            <Menu label={`Rohkem: ${name}`}>
                <>
                  {!guest && (
                    <label className="block px-2.5 pt-1.5 pb-2">
                      <span className="block text-[12px] text-[var(--text-2)] mb-1">Plokk</span>
                      <select
                        aria-label={`Plokk: ${name}`}
                        value={b.groupId ?? ""}
                        onChange={(e) => { act(() => call("PATCH", "/api/bills", { id: b.id, groupId: e.target.value || null })); }}
                        className="w-full rounded-md border border-[var(--line-strong)] bg-[var(--surface-1)] px-2 h-8 text-[13px] text-[var(--text)]"
                      >
                        <option value="">Sorteerimata</option>
                        {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                    </label>
                  )}
                  {!guest && (
                    <button type="button" aria-label={`Muuda: ${name}`} className={`${MENU_ITEM} text-[var(--text)]`} onClick={() => setEditing(b.id)}>
                      <Pencil className="w-4 h-4 text-[var(--text-2)]" /> Muuda
                    </button>
                  )}
                  {b.hasFile && (
                    <a href={`/api/bills/file?id=${encodeURIComponent(b.id)}`} target="_blank" rel="noopener noreferrer" aria-label={`Ava PDF: ${name}`} className={`${MENU_ITEM} text-[var(--text)]`}>
                      <FileText className="w-4 h-4 text-[var(--text-2)]" /> Ava PDF
                    </a>
                  )}
                  {b.payUrl && host && (
                    <a href={b.payUrl} target="_blank" rel="noopener noreferrer" aria-label={`Ava makselink (${host}): ${name}`} className={`${MENU_ITEM} text-[var(--text)]`}>
                      <ExternalLink className="w-4 h-4 text-[var(--text-2)]" /> <span className="truncate">Makselink · {host}</span>
                    </a>
                  )}
                  {!guest && (
                    <button type="button" aria-label={`Kustuta: ${name}`} className={`${MENU_ITEM} text-[var(--bill-late)]`}
                      onClick={() => { if (window.confirm(`Kustutada arve "${b.supplier ?? b.subject ?? ""}"? Saad selle taastada nupuga „Kustutatud“.`)) act(() => call("DELETE", `/api/bills?id=${encodeURIComponent(b.id)}`)); }}>
                      <Trash2 className="w-4 h-4" /> Kustuta arve
                    </button>
                  )}
                </>
            </Menu>
          ) : <span aria-hidden className="w-8 shrink-0" />}
        </div>
      </div>
    );
  };

  // One summary row per supplier with 2+ bills; the arrow opens its bills. Single bills stay plain rows.
  const renderSupplier = (blockKey: string, name: string, list: Bill[]) => {
    if (list.length === 1) return renderRow(list[0]);
    const id = `${blockKey}:${name.toLowerCase()}`;
    const isOpen = open.has(id);
    const ol = openLabel(list);
    const sum = ol.eur.reduce((s, b) => s + (b.amountCents ?? 0), 0);
    const late = list.filter((b) => isOverdue(b, todayIso)).length;
    const first = list[0];
    const u = urgency(first);
    return (
      <div key={id} className="border-t border-[var(--line)] first:border-t-0">
        <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? "Sulge" : "Ava"} arved: ${name}`}
          onClick={() => setOpen((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          className={`${ROW_GRID} w-full py-3 text-left rounded-md transition-colors ${ROW_HOVER}`}>
          <div className="min-w-0 flex items-center gap-1.5">
            <ChevronRight aria-hidden className={`w-4 h-4 -ml-1 shrink-0 text-[var(--text-2)] transition-transform duration-150 motion-reduce:transition-none ${isOpen ? "rotate-90" : ""}`} />
            <div className="min-w-0">
              <div className="text-[14px] text-[var(--text)] truncate">{name}</div>
              <div className="text-[12px] text-[var(--text-2)] truncate">{ol.text}{late > 0 ? ` · ${late} hilinenud` : ""}</div>
            </div>
          </div>
          {dueCell(first.dueDate, u, u.tone === "warn")}
          <div className={`num text-[14px] font-medium text-right whitespace-nowrap col-start-2 row-start-1 sm:col-start-3 sm:row-start-auto ${late > 0 ? "text-[var(--bill-late)]" : "text-[var(--text)]"}`}>{money(sum, "EUR")}</div>
          <span aria-hidden className="hidden sm:block" />
        </button>
        {isOpen && <div className="ml-3 sm:ml-5 pl-3 border-l border-[var(--line)] pb-2">{list.map((b) => renderRow(b))}</div>}
      </div>
    );
  };

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <div className="hq-rise pt-4 pb-6 flex items-end justify-between gap-4">
        <div>
          <Eyebrow>Isiklikud</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">Arved</h1>
          <p className="text-[13.5px] text-[var(--text-2)] mt-2">
            {openLabel(shownBills).text} · {review.length} vajab ülevaatust
          </p>
        </div>
        {!guest && <div className="flex items-center gap-2">
          <button type="button" onClick={syncMail} disabled={syncing !== null} aria-label="Too uued arved meilidest" title="Too uued arved meilidest" className="btn-ghost inline-flex items-center justify-center w-9 h-9 disabled:opacity-60"><RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} /></button>
          <Button variant="primary" onClick={() => setAdding((v) => !v)}><Plus className="w-4 h-4" /> Lisa arve</Button>
        </div>}
      </div>

      {syncing && <div role="status" className="mb-4 text-[13px] text-[var(--text-2)]">{syncing}</div>}
      {error && <div role="alert" className="mb-4 rounded-md border border-[var(--bill-late)] px-3 py-2 text-[13px] text-[var(--bill-late)]">{error}</div>}

      {adding && (
        <BillForm groups={groups} onDone={() => { setAdding(false); load(); }} onError={setError} />
      )}

      {review.length > 0 && (
        <div id="plokk-review" className="scroll-mt-24 mb-6"><Panel className="p-4 sm:p-5">
          <div className="flex items-center gap-2 px-3">
            <AlertTriangle aria-hidden className="w-4 h-4 text-[var(--warn)]" />
            <h2 className="text-[17px] font-semibold text-[var(--text)]">Vaata üle <span className="num font-normal text-[var(--text-2)]">{review.length}</span></h2>
          </div>
          <p className="px-3 mt-1 mb-4 max-w-[70ch] text-[12.5px] text-[var(--text-2)]">Summa või tähtaeg puudub või lugemine ebaõnnestus. Parandamiseks vali „⋯“ ja „Muuda“, või jäta; tähtajaga ridadele tuleb meeldetuletus ka siin.</p>
          <RowHead />
          {review.map((b) => renderRow(b))}
        </Panel></div>
      )}

      {/* One compact summary line; blocks appear only as small jump links (their totals live in each block header). */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-y border-[var(--line)] py-3">
        {total.count > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-2 text-[14px]">
            <span className="text-[var(--text-2)]">Maksta kokku</span>
            <span className="num font-semibold text-[var(--text)] whitespace-nowrap">{money(total.sum, "EUR")}</span>
            <span className="text-[var(--text-2)] whitespace-nowrap">· {total.count} {total.count === 1 ? "arve" : "arvet"}</span>
            {total.late > 0 && <span className="text-[var(--bill-late)] whitespace-nowrap">· {total.late} hilinenud</span>}
          </div>
        ) : <span className="text-[14px] text-[var(--text-2)]">{bills.length > 0 && shownBills.length === 0 ? "Midagi pole valitud" : "Kõik makstud"}</span>}
        <div role="group" aria-label="Näidatavad plokid" className="flex flex-wrap items-center gap-x-1 gap-y-1 -mx-2">
          {overview.map((o) => {
            const chip = "inline-flex items-center gap-2 h-8 px-2 rounded-md text-[13px] text-[var(--text-2)] whitespace-nowrap transition-colors hover:text-[var(--text)] hover:bg-[var(--surface-2)]";
            const dot = <span aria-hidden className="w-2 h-2 rounded-full" style={{ background: o.color }} />;
            // "Vaata üle" is not a block: it stays a jump link and is always shown.
            if (o.id === "review") return <a key={o.id} href="#plokk-review" className={chip}>{dot}{o.name}</a>;
            return (
              <label key={o.id} className={`${chip} cursor-pointer`}>
                <input type="checkbox" checked={!hidden.has(o.id)} onChange={() => toggleBlock(o.id)} className="accent-[var(--accent)]" />
                {dot}
                {o.name}
              </label>
            );
          })}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" aria-pressed={showPaid} onClick={() => setShowPaid((v) => !v)} className="btn-ghost inline-flex items-center h-8 px-3 text-[12.5px]">
          {showPaid ? "Peida vanemad makstud" : "Näita vanemad makstud"}
        </button>
        {!guest && (
          <button type="button" aria-expanded={showDeleted} onClick={() => setShowDeleted((v) => !v)} className="btn-ghost inline-flex items-center gap-1.5 h-8 px-3 text-[12.5px]">
            <Trash2 className="w-3.5 h-3.5" /> Kustutatud ({deleted.length})
          </button>
        )}
        {!guest && <button type="button" onClick={() => setAddingGroup((v) => !v)} className="btn-ghost inline-flex items-center gap-1.5 h-8 px-3 text-[12.5px]"><Plus className="w-3.5 h-3.5" /> Uus plokk</button>}
      </div>
      {addingGroup && <AddGroup onDone={() => { setAddingGroup(false); load(); }} onError={setError} />}


      {showDeleted && !guest && (
        <section aria-label="Kustutatud arved" className="mb-6 rounded-[var(--r-lg)] border border-[var(--line)] px-5 py-4">
          <h2 className="text-[15px] font-semibold text-[var(--text)]">Kustutatud arved</h2>
          {deleted.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-[var(--text-2)]">Kustutatud arveid pole.</p>
          ) : (
            <ul className="mt-2">
              {deleted.map((b) => {
                const name = b.supplier ?? b.subject ?? "(nimeta)";
                return (
                  <li key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 border-t border-[var(--line)] first:border-t-0">
                    <div className="min-w-0 flex-1 basis-[180px]">
                      <div className="text-[14px] text-[var(--text)] truncate">{name}</div>
                      <div className="text-[12px] text-[var(--text-2)] truncate">
                        {[groups.find((g) => g.id === b.groupId)?.name ?? "Sorteerimata", `tähtaeg ${fmtDate(b.dueDate)}`,
                          b.status === "paid" && "makstud", `kustutatud ${new Date(b.deletedAt!).toLocaleDateString("et-EE", { timeZone: "Europe/Tallinn" })}`].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <span className="num text-[13.5px] text-[var(--text)] whitespace-nowrap">
                      {money(b.amountCents, b.currency)}
                    </span>
                    <button type="button" aria-label={`Taasta: ${name}`} className="btn-ghost inline-flex items-center gap-1.5 h-8 px-3 text-[12.5px]"
                      onClick={() => act(() => call("PATCH", "/api/bills", { id: b.id, restore: true }))}>
                      <Undo2 className="w-3.5 h-3.5" /> Taasta
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <div className="grid gap-6">
        {loading && bills.length === 0 && <div role="status" className="text-[13px] text-[var(--text-2)]">Laen…</div>}
        {!loading && groups.length > 0 && blocks.every((bl) => hidden.has(bl.key) || (!bl.group && bl.items.length === 0)) && (
          <div role="status" className="text-[13px] text-[var(--text-2)]">Ühtegi plokki pole valitud. Märgi ülal vähemalt üks linnuke.</div>
        )}
        {blocks.map(({ key, group, items }, i) => {
          if (!group && items.length === 0 && groups.length > 0) return null;
          if (hidden.has(key)) return null;
          const ol = openLabel(items);
          const late = items.filter((b) => isOverdue(b, todayIso)).length;
          const sum = ol.eur.reduce((s, b) => s + (b.amountCents ?? 0), 0);
          const color = group ? GROUP_COLORS[i % GROUP_COLORS.length] : "var(--text-3)";
          return (
            <div key={key} id={`plokk-${key}`} className="scroll-mt-24">
              <Panel className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-3 pb-4 mb-2 border-b border-[var(--line)]">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2.5 text-[17px] font-semibold text-[var(--text)]">
                      <span aria-hidden className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
                      {group ? group.name : "Sorteerimata"}
                      {group && !guest && group.guestVisible && <span className="text-[12px] font-normal text-[var(--text-2)]">· Kersti näeb</span>}
                    </h2>
                    {group?.address && <div className="text-[12.5px] text-[var(--text-2)] mt-0.5 ml-5">{group.address}</div>}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="num text-[15px] font-semibold text-[var(--text)] whitespace-nowrap">{money(sum, "EUR")}</div>
                      <div className="text-[12px] text-[var(--text-2)] whitespace-nowrap">
                        {ol.text}{late > 0 && <span className="text-[var(--bill-late)]"> · {late} hilinenud</span>}
                      </div>
                    </div>
                    {group && !guest && (
                      <Menu label={`Ploki seaded: ${group.name}`}>
                          <>
                            <label className={`${MENU_ITEM} text-[var(--text)] cursor-pointer`}>
                              <input type="checkbox" checked={group.guestVisible} className="accent-[var(--accent)]"
                                onChange={(e) => act(() => call("PATCH", "/api/bill-groups", { id: group.id, guestVisible: e.target.checked }))} />
                              Kersti näeb
                            </label>
                            <button type="button" aria-label={`Kustuta plokk: ${group.name}`} className={`${MENU_ITEM} text-[var(--bill-late)]`}
                              onClick={() => { if (window.confirm(`Kustutada plokk "${group.name}"? Arved jäävad alles (Sorteerimata).`)) act(() => call("DELETE", `/api/bill-groups?id=${encodeURIComponent(group.id)}`)); }}>
                              <Trash2 className="w-4 h-4" /> Kustuta plokk
                            </button>
                          </>
                      </Menu>
                    )}
                  </div>
                </div>
                {items.length === 0 ? <EmptyState title="Arveid ei ole" className="!py-6" /> : (
                  <>
                    <RowHead />
                    {bySupplier(items).map((s) => renderSupplier(key, s.name, s.items))}
                  </>
                )}
              </Panel>
            </div>
          );
        })}
      </div>

      {ignored.length > 0 && (
        <details className="mt-6 rounded-[var(--r-lg)] border border-[var(--line)] px-5 py-4 text-[12.5px] text-[var(--text-2)]">
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

// Adds a bill, or edits `bill` when given.
function BillForm({ bill, groups, onDone, onError, onCancel }: { bill?: Bill; groups: Group[]; onDone: () => void; onError: (m: string) => void; onCancel?: () => void }) {
  const [f, setF] = useState({
    supplier: bill?.supplier ?? "",
    amount: bill?.amountCents == null ? "" : (bill.amountCents / 100).toFixed(2).replace(".", ","),
    dueDate: bill?.dueDate ?? "",
    groupId: bill?.groupId ?? "",
    reference: bill?.reference ?? "",
    iban: bill?.iban ?? "",
    notes: bill?.notes ?? "",
  });
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
      const fields = {
        supplier, amount, dueDate: f.dueDate || null, groupId: f.groupId || null,
        reference: f.reference || null, iban: f.iban || null, notes: f.notes || null,
      };
      if (bill) {
        // A "Vaata üle" bill that now has both amount and due date becomes an ordinary open bill.
        const fixed = bill.status === "review" && amount !== null && f.dueDate !== "";
        await call("PATCH", "/api/bills", { id: bill.id, ...fields, ...(fixed ? { status: "new" } : {}) });
      } else {
        await call("POST", "/api/bills", fields);
      }
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
      <input aria-label="IBAN" className={inp} placeholder="IBAN" value={f.iban} onChange={set("iban")} maxLength={40} />
      <input aria-label="Märkus" className={`${inp} sm:col-span-3`} placeholder="Märkus" value={f.notes} onChange={set("notes")} maxLength={1000} />
      <div className="sm:col-span-3 flex items-center gap-2">
        <Button variant="primary" type="submit" disabled={busy}>Salvesta</Button>
        {onCancel && <button type="button" onClick={onCancel} className="btn-ghost inline-flex items-center h-9 px-3 text-[13px]">Tühista</button>}
      </div>
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
