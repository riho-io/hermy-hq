"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, UserRound } from "lucide-react";
import { Panel, Button, Eyebrow } from "@/components/ui/kit";

const QUESTIONS: { key: string; label: string; placeholder: string; type?: string }[] = [
  { key: "nimi", label: "Sinu nimi", placeholder: "nt Riho" },
  { key: "ettevõte", label: "Ettevõte / projekt", placeholder: "nt Põhja Mööbel OÜ (PML)" },
  { key: "roll", label: "Sinu roll", placeholder: "nt omanik, sisulooja" },
  { key: "nišš", label: "Nišš / valdkond", placeholder: "nt mööbel, AI sisu" },
  { key: "auditoorium", label: "Kes on su sihtgrupp?", placeholder: "nt Eesti mööbliostjad, AI-huvilised" },
  { key: "hääl", label: "Sinu toon / hääl sisus", placeholder: "nt asjalik, soe, otsekohene" },
  { key: "eesmärk", label: "Sinu 90-päeva eesmärk", placeholder: "nt kasvatada tellimuste arvu, käivitada sisukanali" },
  { key: "prioriteedid", label: "Peamised prioriteedid", placeholder: "nt äri kasv, sisu, AI-projektid" },
];

export default function OnboardingPage() {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  const check = useCallback(async () => {
    try {
      const r = await fetch("/api/hermes/onboarding");
      if (r.ok) {
        const d = await r.json();
        if (d.done) setDone(true);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { check(); }, [check]);

  const submit = async () => {
    setSaving(true);
    try {
      await fetch("/api/hermes/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      setDone(true);
    } catch { /* ignore */ }
    setSaving(false);
  };

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <Panel className="w-full max-w-md p-8 text-center">
          <div className="w-11 h-11 rounded-[var(--r-md)] bg-white/[0.06] flex items-center justify-center mx-auto">
            <Check className="w-5 h-5" style={{ color: "var(--up)" }} />
          </div>
          <h1 className="mt-5 text-[20px] font-semibold text-[var(--text)]">Profiil on täidetud</h1>
          <p className="eyebrow mt-2">Hermes teab, kellega ta töötab.</p>
          <a href="/" className="btn-primary inline-flex items-center justify-center w-full mt-6 py-3 text-[13px]">
            Mine töölauale <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
          </a>
        </Panel>
      </div>
    );
  }

  const q = QUESTIONS[step];

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-10">
      <div className="w-full max-w-md">
        <Panel className="p-8">
          <div className="flex items-center gap-2.5 mb-6">
            <UserRound className="w-4 h-4" style={{ color: "var(--accent)" }} />
            <Eyebrow>Onboarding · {step + 1}/{QUESTIONS.length}</Eyebrow>
          </div>
          <div className="h-[3px] rounded-full bg-white/[0.06] overflow-hidden mb-6">
            <div className="h-full rounded-full" style={{ width: `${((step + 1) / QUESTIONS.length) * 100}%`, background: "var(--accent)" }} />
          </div>
          <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--text)] mb-1">{q.label}</h1>
          <p className="text-[13px] text-[var(--text-3)] mb-5">Hermes salvestab selle oma püsimällu, et ta teaks su äri, auditooriumi ja häält — ilma et peaksid iga kord uuesti selgitama.</p>
          <input
            autoFocus
            value={answers[q.key] || ""}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter" && answers[q.key]?.trim()) { step < QUESTIONS.length - 1 ? setStep(step + 1) : submit(); } }}
            placeholder={q.placeholder}
            className="w-full bg-transparent text-[14px] text-[var(--text)] placeholder:text-[var(--text-3)] px-3.5 py-2.5 rounded-[10px] border border-[var(--line)] focus:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] outline-none transition-colors"
          />
          <div className="flex items-center justify-between mt-6">
            <button type="button" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}
              className="text-[12.5px] font-medium text-[var(--text-3)] hover:text-[var(--text-2)] disabled:opacity-30 transition-colors">
              ← Tagasi
            </button>
            <Button variant="primary" onClick={() => step < QUESTIONS.length - 1 ? setStep(step + 1) : submit()} disabled={saving || !answers[q.key]?.trim()}>
              {saving ? "Salvestan…" : step < QUESTIONS.length - 1 ? "Järgmine" : "Valmis ✓"}
            </Button>
          </div>
        </Panel>
        <p className="text-center num text-[11px] text-[var(--text-4)] mt-4">Võid jätta küsimusi vahele — see on sinu profiil.</p>
      </div>
    </div>
  );
}
