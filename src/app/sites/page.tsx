"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { Panel, SectionHeader, Eyebrow, Pill, Skeleton, EmptyState } from "@/components/ui/kit";

interface Check {
  name: string;
  status: "ok" | "problem";
  line: string;
  problem: string | null;
}

interface SitesData {
  checked_at: string | null;
  checks: Check[];
  problems_count: number;
}

function formatCheckedAt(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CheckCard({ check }: { check: Check }) {
  const ok = check.status === "ok";
  return (
    <Panel className="p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${ok ? "bg-[color-mix(in_srgb,var(--up)_12%,transparent)]" : "bg-[color-mix(in_srgb,var(--down)_12%,transparent)]"}`}>
            {ok ? (
              <CheckCircle2 className="w-4 h-4" style={{ color: "var(--up)" }} />
            ) : (
              <AlertTriangle className="w-4 h-4" style={{ color: "var(--down)" }} />
            )}
          </span>
          <h2 className="text-[15px] font-semibold text-[var(--text)]">{check.name}</h2>
        </div>
        <Pill tone={ok ? "up" : "down"}>{ok ? "OK" : "PROBLEEM"}</Pill>
      </div>
      <p className="text-[12.5px] leading-relaxed text-[var(--text-3)]">{check.line}</p>
      {!ok && check.problem && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--down)]">{check.problem}</p>
      )}
    </Panel>
  );
}

export default function SitesPage() {
  const [data, setData] = useState<SitesData>({ checked_at: null, checks: [], problems_count: 0 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/sites", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <div className="hq-rise pt-4 pb-8 flex items-end justify-between gap-4">
        <div>
          <Eyebrow>Turvaseire</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
            Kodulehed
          </h1>
          <p className="text-[13.5px] text-[var(--text-3)] mt-2 max-w-[65ch]">
            {data.checked_at
              ? `Viimati kontrollitud ${formatCheckedAt(data.checked_at)}`
              : "Kodulehtede seisu pole veel kontrollitud."}
          </p>
        </div>
        <button type="button" onClick={load} aria-label="Värskenda" className="btn-ghost inline-flex items-center justify-center w-9 h-9">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : data.checked_at === null ? (
        <EmptyState
          title="Pole veel andmeid"
          hint="Käivita VPS-il: python3 ~/.hermes/scripts/konto_check.py --push"
        />
      ) : (
        <>
          <SectionHeader
            label="Kontrollid"
            title={`${data.checks.length} kodulehte jälgimisel`}
            action={
              data.problems_count > 0 ? (
                <Pill tone="down">{data.problems_count} probleemi</Pill>
              ) : (
                <Pill tone="up">Kõik korras</Pill>
              )
            }
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.checks.map((check) => (
              <CheckCard key={check.name} check={check} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
