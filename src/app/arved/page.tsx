"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Plus, RefreshCw, FileText, Trash2, Check, Undo2, AlertTriangle } from "lucide-react";
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

  const load = useCallback(async () => {
    setLoading(true);
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

  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Viga"); }
    load();
  };

  const review = bills.filter((b) => b.status === "review");
  const blocks = useMemo(() => {
    const list = bills.filter((b) => b.status !== "review" && b.status !== "ignored" && (showPaid || b.status !== "paid"));
    const byGroup = (id: string | null) => list.filter((b) => b.groupId === id);
    return [...groups.map((g) => ({ key: g.id, group: g as Group | null, items: byGroup(g.id) })),
            { key: "none", group: null as Group | null, items: byGroup(null) }];
  }, [bills, groups, showPaid]);
  const ignored = bills.filter((b) => b.status === "ignored");
  const openLabel = (list: Bill[]) => {
    const nw = list.filter((b) => b.status === "new");
    const eur = nw.filter((b) => b.currency === "EUR");
    const other = nw.length - eur.length;
    return { eur, text: `${eur.length} maksmata${other > 0 ? ` + ${other} muus vääringus` : ""}` };
  };

  const renderRow = (b: Bill) => {
    const u = urgency(b);
    const host = b.payUrl ? payHost(b.payUrl) : null;
    const name = b.supplier ?? b.subject ?? "(nimeta)";
    return (
      <div key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 border-t border-[var(--line)] first:border-t-0">
        <div className="min-w-[180px] flex-1">
          <div className="text-[14px] text-[var(--text)]">{b.supplier ?? b.subject ?? "(nimeta)"}</div>
          <div className="text-[12px] text-[var(--text-3)]">
            {[b.reference && `viide ${b.reference}`, b.iban, b.source === "manual" && "käsitsi"].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="num text-[14px] text-[var(--text)]">{money(b.amountCents, b.currency)}</div>
        <div className="text-[12.5px] text-[var(--text-2)] w-[92px]">{fmtDate(b.dueDate)}</div>
        <Pill tone={u.tone}>{u.label}</Pill>
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
          <button type="button" onClick={load} aria-label="Värskenda" className="btn-ghost inline-flex items-center justify-center w-9 h-9"><RefreshCw className="w-4 h-4" /></button>
          <Button variant="primary" onClick={() => setAdding((v) => !v)}><Plus className="w-4 h-4" /> Lisa arve</Button>
        </div>
      </div>

      {error && <div role="alert" className="mb-4 rounded-md border border-[var(--down)] px-3 py-2 text-[13px] text-[var(--down)]">{error}</div>}

      {adding && (
        <AddBill groups={groups} onDone={() => { setAdding(false); load(); }} onError={setError} />
      )}

      {review.length > 0 && (
        <Panel>
          <div className="flex items-center gap-2 mb-2 text-[var(--text)]">
            <AlertTriangle className="w-4 h-4 text-[var(--warn)]" />
            <h2 className="text-[16px] font-semibold">Vaata üle ({review.length})</h2>
          </div>
          <p className="text-[12.5px] text-[var(--text-3)] mb-2">Summa või tähtaeg puudub või lugemine ebaõnnestus. Parandamiseks kustuta ja lisa käsitsi, või jäta; tähtajaga ridadele tuleb meeldetuletus ka siin.</p>
          {review.map(renderRow)}
        </Panel>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button type="button" onClick={() => setShowPaid((v) => !v)} className="text-[12.5px] text-[var(--text-3)] underline">
          {showPaid ? "Peida makstud" : "Näita makstud"}
        </button>
        <button type="button" onClick={() => setAddingGroup((v) => !v)} className="text-[12.5px] text-[var(--text-3)] underline">Uus plokk</button>
      </div>
      {addingGroup && <AddGroup onDone={() => { setAddingGroup(false); load(); }} onError={setError} />}

      <div className="mt-4 grid gap-4">
        {loading && bills.length === 0 && <div className="text-[13px] text-[var(--text-3)]">Laen…</div>}
        {blocks.map(({ key, group, items }) => {
          if (!group && items.length === 0 && groups.length > 0) return null;
          const ol = openLabel(items);
          const sum = ol.eur.reduce((s, b) => s + (b.amountCents ?? 0), 0);
          return (
            <Panel key={key}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
                <div>
                  <h2 className="text-[18px] font-semibold text-[var(--text)]">{group ? group.name : "Sorteerimata"}</h2>
                  {group?.address && <div className="text-[12.5px] text-[var(--text-3)]">{group.address}</div>}
                </div>
                <div className="num text-[13px] text-[var(--text-2)]">{ol.text} · {money(sum, "EUR")}</div>
              </div>
              {items.length === 0 ? <EmptyState title="Arveid ei ole" /> : items.map(renderRow)}
              {group && (
                <button type="button" aria-label={`Kustuta plokk: ${group.name}`} className="mt-2 text-[12px] text-[var(--text-3)] underline"
                  onClick={() => { if (window.confirm(`Kustutada plokk "${group.name}"? Arved jäävad alles (Sorteerimata).`)) act(() => call("DELETE", `/api/bill-groups?id=${encodeURIComponent(group.id)}`)); }}>
                  Kustuta plokk
                </button>
              )}
            </Panel>
          );
        })}
      </div>

      {ignored.length > 0 && (
        <details className="mt-6 text-[12.5px] text-[var(--text-3)]">
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
