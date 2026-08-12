"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, RefreshCw, Pin } from "lucide-react";
import { Panel, SectionHeader, Eyebrow, EmptyState, Skeleton } from "@/components/ui/kit";

interface Skill { id: string; label: string; category: string; useCount: number; state: string; pinned: boolean }

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/hermes/skills");
      if (r.ok) {
        const d = await r.json();
        setSkills(d.skills ?? []);
        setSyncedAt(d.syncedAt ?? null);
      }
    } catch { /* offline */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const maxUse = Math.max(1, ...skills.map((s) => s.useCount));

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <div className="hq-rise pt-4 pb-8 flex items-end justify-between gap-4">
        <div>
          <Eyebrow>Oskuste inventuur</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
            Skills
          </h1>
          <p className="num text-[12px] text-[var(--text-3)] mt-2">{skills.length} skilli · aegunud: {skills.filter((s) => s.state === "archived").length}</p>
        </div>
        <div className="flex items-center gap-2.5">
          {syncedAt && (
            <span className="num text-[11px] text-[var(--text-3)]">
              sünkroonitud {new Date(syncedAt).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button type="button" onClick={load} aria-label="Värskenda" className="btn-ghost inline-flex items-center justify-center w-9 h-9">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" />
          <Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" />
        </div>
      ) : skills.length === 0 ? (
        <Panel className="p-2">
          <EmptyState icon={<BookOpen className="w-6 h-6" />} title="Skillid pole veel sünkroonitud" hint="Bridge peegeldab oskusi iga 30 sekundi järel — tule natukese aja pärast tagasi." />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {skills.map((s) => (
            <Panel key={s.id} className="p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-[var(--text)] truncate">{s.label}</span>
                    {s.pinned && <Pin className="w-3 h-3 text-[var(--accent)] shrink-0" />}
                  </div>
                  {s.category && <span className="text-[10.5px] uppercase tracking-wide text-[var(--text-3)]">{s.category}</span>}
                </div>
                <span className="num text-[18px] font-semibold text-[var(--text)] shrink-0">{s.useCount}</span>
              </div>
              <div className="h-[4px] rounded-full bg-white/[0.06] overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${Math.max(4, (s.useCount / maxUse) * 100)}%`, background: "var(--accent)", opacity: 0.85 }} />
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="num text-[10px] text-[var(--text-3)]">kasutuskorda</span>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${s.state === "active" ? "text-[var(--up)] bg-[color-mix(in_srgb,var(--up)_10%,transparent)]" : s.state === "archived" ? "text-[var(--down)] bg-[color-mix(in_srgb,var(--down)_10%,transparent)]" : "text-[var(--text-3)] bg-white/[0.05]"}`}>
                  {s.state === "active" ? "aktiivne" : s.state === "archived" ? "aegunud" : s.state}
                </span>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
