"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  CalendarDays,
  Repeat,
  Check,
  Circle,
} from "lucide-react";
import {
  Panel,
  SectionHeader,
  Eyebrow,
  Pill,
  Skeleton,
  EmptyState,
  Button,
} from "@/components/ui/kit";

interface Reminder {
  id: string;
  title: string;
  category: string;
  amount: string | null;
  dueDate: string | null;
  repeat: string;
  status: string;
  notes: string | null;
}

const REPEAT_LABEL: Record<string, string> = {
  none: "",
  yearly: "Kordub aastas",
  monthly: "Kordub kuus",
  weekly: "Kordub nädalas",
};

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

type Urgency = { label: string; tone: "neutral" | "warn" | "down" | "up" };

function urgency(iso: string | null): Urgency {
  if (!iso) return { label: "Ilma tähtajata", tone: "neutral" };
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  const today = todayStart();
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) {
    const n = Math.abs(diffDays);
    return { label: `Tähtaeg möödas (${n} päeva)`, tone: "down" };
  }
  if (diffDays === 0) return { label: "Täna", tone: "warn" };
  if (diffDays === 1) return { label: "Homme", tone: "warn" };
  if (diffDays <= 7) return { label: `${diffDays} päeva`, tone: "warn" };
  return { label: `${diffDays} päeva`, tone: "neutral" };
}

const CATEGORY_ICONS: Record<string, string> = {
  Maksed: "€",
  Kindlustus: "🛡",
  Leping: "📄",
  Hooldus: "🔧",
  Maksud: "🏛",
};

const emptyForm = {
  title: "",
  category: "Maksed",
  amount: "",
  dueDate: "",
  repeat: "none",
  notes: "",
};

export default function RemindersPage() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string>("Kõik");
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<Reminder | "new" | null>(null);
  const [form, setForm] = useState(emptyForm);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/reminders", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setReminders(data.reminders || []);
        setCategories(data.categories || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openNew = () => {
    setForm({ ...emptyForm, category: categories[0] || "Maksed" });
    setEditing("new");
  };

  const openEdit = (r: Reminder) => {
    setForm({
      title: r.title,
      category: r.category,
      amount: r.amount || "",
      dueDate: r.dueDate ? r.dueDate.slice(0, 10) : "",
      repeat: r.repeat,
      notes: r.notes || "",
    });
    setEditing(r);
  };

  const closeEditor = () => {
    setEditing(null);
    setForm(emptyForm);
  };

  const save = async () => {
    if (!form.title.trim()) return;
    const body = {
      title: form.title,
      category: form.category.trim() || "Muud",
      amount: form.amount,
      dueDate: form.dueDate || null,
      repeat: form.repeat,
      notes: form.notes,
    };
    if (editing === "new") {
      await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else if (editing) {
      await fetch("/api/reminders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editing.id, ...body }),
      });
    }
    closeEditor();
    load();
  };

  const toggleDone = async (r: Reminder) => {
    await fetch("/api/reminders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: r.id,
        status: r.status === "done" ? "active" : "done",
      }),
    });
    load();
  };

  const remove = async (r: Reminder) => {
    if (!window.confirm(`Kustutada meeldetuletus "${r.title}"?`)) return;
    await fetch(`/api/reminders?id=${encodeURIComponent(r.id)}`, {
      method: "DELETE",
    });
    load();
  };

  const visible = useMemo(() => {
    let list = reminders;
    if (categoryFilter !== "Kõik") list = list.filter((r) => r.category === categoryFilter);
    if (!showDone) list = list.filter((r) => r.status === "active");
    return list;
  }, [reminders, categoryFilter, showDone]);

  const activeCount = reminders.filter((r) => r.status === "active").length;
  const dueSoonCount = reminders.filter(
    (r) => r.status === "active" && r.dueDate && urgency(r.dueDate).tone !== "neutral"
  ).length;

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <div className="hq-rise pt-4 pb-8 flex items-end justify-between gap-4">
        <div>
          <Eyebrow>Üldised tähtajad</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
            Meeldetuletused
          </h1>
          <p className="text-[13.5px] text-[var(--text-3)] mt-2 max-w-[65ch]">
            {activeCount > 0
              ? `${activeCount} aktiivset · ${dueSoonCount} vajab peagi tähelepanu`
              : "Pole veel ühtegi aktiivset meeldetuletust."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={load} aria-label="Värskenda" className="btn-ghost inline-flex items-center justify-center w-9 h-9">
            <RefreshCw className="w-4 h-4" />
          </button>
          <Button variant="primary" onClick={openNew}>
            <Plus className="w-4 h-4" /> Lisa
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {["Kõik", ...categories].map((cat) => {
          const active = categoryFilter === cat;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setCategoryFilter(cat)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-all border ${
                active
                  ? "bg-[var(--surface-2)] text-[var(--text)] border-[var(--line-strong)]"
                  : "text-[var(--text-3)] border-[var(--line)] hover:text-[var(--text-2)] hover:border-[var(--line-strong)]"
              }`}
            >
              {CATEGORY_ICONS[cat] && (
                <span className="text-[11px] leading-none">{CATEGORY_ICONS[cat]}</span>
              )}
              {cat}
              <span className="num text-[10.5px] opacity-60">
                {cat === "Kõik"
                  ? reminders.length
                  : reminders.filter((r) => r.category === cat).length}
              </span>
            </button>
          );
        })}
        <span className="mx-1 w-px h-5 bg-[var(--line)]" />
        <button
          type="button"
          onClick={() => setShowDone((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-all border ${
            showDone
              ? "bg-[color-mix(in_srgb,var(--up)_10%,transparent)] text-[var(--up)] border-[color-mix(in_srgb,var(--up)_30%,transparent)]"
              : "text-[var(--text-3)] border-[var(--line)] hover:text-[var(--text-2)]"
          }`}
        >
          <Check className="w-3.5 h-3.5" /> Tehtud {showDone ? "peidus" : "näha"}
        </button>
      </div>

      {/* Editor */}
      {editing && (
        <div className="hq-rise elevated mb-6 p-5">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Mida tuleb meeles pidada?"
              className="md:col-span-6 bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] placeholder-[var(--text-3)] rounded-[var(--r-md)] px-4 py-2.5 text-[14px] focus:outline-none focus:border-[var(--line-strong)]"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
            <input
              type="text"
              list="category-options"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              placeholder="Kategooria"
              className="md:col-span-2 bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] placeholder-[var(--text-3)] rounded-[var(--r-md)] px-4 py-2.5 text-[14px] focus:outline-none focus:border-[var(--line-strong)]"
            />
            <datalist id="category-options">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
              className="md:col-span-1 bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] rounded-[var(--r-md)] px-4 py-2.5 text-[14px] focus:outline-none focus:border-[var(--line-strong)]"
            />
            <input
              type="text"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder="Summa (nt 45 €)"
              className="md:col-span-1 bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] placeholder-[var(--text-3)] rounded-[var(--r-md)] px-4 py-2.5 text-[14px] focus:outline-none focus:border-[var(--line-strong)]"
            />
            <select
              value={form.repeat}
              onChange={(e) => setForm({ ...form, repeat: e.target.value })}
              className="md:col-span-2 bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] rounded-[var(--r-md)] px-4 py-2.5 text-[14px] focus:outline-none focus:border-[var(--line-strong)]"
            >
              <option value="none">Ei kordu</option>
              <option value="yearly">Kordub aastas (nt kindlustus)</option>
              <option value="monthly">Kordub kuus</option>
              <option value="weekly">Kordub nädalas</option>
            </select>
            <input
              type="text"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Märkused (valikuline)"
              className="md:col-span-4 bg-[var(--surface-1)] border border-[var(--line)] text-[var(--text)] placeholder-[var(--text-3)] rounded-[var(--r-md)] px-4 py-2.5 text-[14px] focus:outline-none focus:border-[var(--line-strong)]"
            />
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="primary" onClick={save}>
              {editing === "new" ? "Lisa meeldetuletus" : "Salvesta"}
            </Button>
            <Button variant="ghost" onClick={closeEditor}>
              Tühista
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Bell className="w-6 h-6" />}
          title={reminders.length === 0 ? "Pole veel meeldetuletusi" : "Ei leidu sobivaid"}
          hint={
            reminders.length === 0
              ? "Lisa esimene meeldetuletus — näiteks kindlustuse lõppemine või arve tähtaeg."
              : "Proovi teist filtrit või näita tehtuid."
          }
          action={
            reminders.length === 0 ? (
              <Button variant="primary" onClick={openNew}>
                <Plus className="w-4 h-4" /> Lisa meeldetuletus
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <SectionHeader
            label="Meeldetuletused"
            title={
              categoryFilter === "Kõik"
                ? `${visible.length} kirjet`
                : `${visible.length} kirjet · ${categoryFilter}`
            }
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {visible.map((r) => {
              const u = urgency(r.dueDate);
              const isDone = r.status === "done";
              return (
                <Panel key={r.id} className={`p-5 ${isDone ? "opacity-60" : ""}`}>
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => toggleDone(r)}
                      aria-label={isDone ? "Taasta" : "Märgi tehtuks"}
                      className="mt-0.5 shrink-0 text-[var(--text-3)] hover:text-[var(--up)] transition-colors"
                    >
                      {isDone ? (
                        <Check className="w-5 h-5 text-[var(--up)]" />
                      ) : (
                        <Circle className="w-5 h-5" />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className={`text-[15px] font-semibold text-[var(--text)] ${isDone ? "line-through" : ""}`}>
                          {r.title}
                        </h3>
                        <Pill tone={isDone ? "neutral" : "accent"}>{r.category}</Pill>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap text-[12.5px] text-[var(--text-3)]">
                        {r.dueDate && (
                          <span className="inline-flex items-center gap-1.5">
                            <CalendarDays className="w-3.5 h-3.5" />
                            {fmtDate(r.dueDate)}
                          </span>
                        )}
                        {r.amount && (
                          <span className="num font-semibold text-[var(--text-2)]">{r.amount}</span>
                        )}
                        {r.repeat !== "none" && (
                          <span className="inline-flex items-center gap-1.5">
                            <Repeat className="w-3.5 h-3.5" />
                            {REPEAT_LABEL[r.repeat]}
                          </span>
                        )}
                      </div>
                      {r.notes && (
                        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-3)]">{r.notes}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEdit(r)}
                        aria-label="Muuda"
                        className="p-1.5 text-[var(--text-3)] hover:text-[var(--text)] transition-colors rounded-lg hover:bg-[var(--surface-1)]"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(r)}
                        aria-label="Kustuta"
                        className="p-1.5 text-[var(--text-3)] hover:text-[var(--down)] transition-colors rounded-lg hover:bg-[var(--surface-1)]"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {!isDone && (
                    <div className="mt-3 pt-3 border-t border-[var(--line)]">
                      <Pill tone={u.tone}>{u.label}</Pill>
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
