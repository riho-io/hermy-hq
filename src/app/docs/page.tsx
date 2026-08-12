"use client";

import { BookOpen, Map, MessageSquare, Cpu, Target, Lightbulb, ShieldCheck, ListChecks } from "lucide-react";
import { Panel, Eyebrow } from "@/components/ui/kit";

const SECTIONS: { icon: React.ReactNode; title: string; text: string }[] = [
  {
    icon: <Map className="w-4 h-4" />,
    title: "Teekonna kaart (Journey Map)",
    text: "Näitab iga Hermese sessiooni kogu teekonna: sõnumid, tööriistakutsed, mudelivahetused ja vead. Vali sessioon vasakult — teekond laaditakse bridge'ilt. Eesmärk: näed täpselt, kus agent eksis, mitte ainult lõppvastust.",
  },
  {
    icon: <MessageSquare className="w-4 h-4" />,
    title: "Vestlus agentidega (Agents)",
    text: "Räägi spetsialist-agentidega otse dashboardilt (Max, Sage, Knox, Nova, Pixel). Vastused tulevad Hermese enda kaudu — seega kasutavad nad sinu mälu, skill'e ja konteksti.",
  },
  {
    icon: <Cpu className="w-4 h-4" />,
    title: "Mudeli vahetamine (Hermes)",
    text: "Vaheta Hermese mudelit 2 klõpsuga (deepseek, claude, gpt, gemini, grok). Päring läheb läbi bridge'i — Vercel ei puuduta otse CLI-d.",
  },
  {
    icon: <Target className="w-4 h-4" />,
    title: "Eesmärgirežiim (Goal mode)",
    text: "Anna üks suur eesmärk — Hermes töötab kuni 30 minutit iseseisvalt. Eesmärk läheb ESMAKT kinnitussisendisse (turvalisus!), pärast kinnitust jookseb taustal ilma teisi töid blokeerimata.",
  },
  {
    icon: <BookOpen className="w-4 h-4" />,
    title: "Oskuste inventuur (Skills)",
    text: "Näitab kõiki Hermese oskusi koos kasutuskordadega — näed, mis on aktiivne, mis aegunud ja mida agent tegelikult kasutab. Andmed tulevad `hermes journey --json` peegeldusest.",
  },
  {
    icon: <ShieldCheck className="w-4 h-4" />,
    title: "Kinnitussisend (Approval inbox)",
    text: "Külgmõjuga tegevused (goal mode, meilid, välismuudatused) ootavad siin sinu otsust. Kinnita või lükka tagasi — agent ei tee kunagi ilma loata midagi olulist.",
  },
  {
    icon: <ListChecks className="w-4 h-4" />,
    title: "Ülesandelaud + Cronid",
    text: "Kanban-laual näed kõiki ülesandeid olekute kaupa. Cronide sektsioonist saad luua ajastatud töid ja vaadata, millal need viimati jooksid.",
  },
  {
    icon: <Lightbulb className="w-4 h-4" />,
    title: "Sisu OS",
    text: "Sisuideed, artiklid, YouTube'i stsenaariumid ja X-postituste voog — kõik ühel lehel. Iga sisu liigub ideest → kinnitatud → postitatud.",
  },
];

export default function DocsPage() {
  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <div className="hq-rise pt-4 pb-8">
        <Eyebrow>Abi</Eyebrow>
        <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
          Dokumentatsioon
        </h1>
        <p className="text-[13.5px] text-[var(--text-3)] mt-2 max-w-[65ch]">
          Hermy HQ on sinu Mission Control: näed, mida Hermes teeb, saad tööd saata, kinnitada riske ja jälgida sisu. Siin on iga mooduli lühikirjeldus.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SECTIONS.map((s, i) => (
          <Panel key={i} className="p-5 hq-rise">
            <div className="flex items-center gap-2.5 mb-2.5">
              <span className="w-7 h-7 rounded-lg bg-white/[0.05] flex items-center justify-center" style={{ color: "var(--accent)" }}>
                {s.icon}
              </span>
              <h2 className="text-[14.5px] font-semibold text-[var(--text)]">{s.title}</h2>
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--text-2)]">{s.text}</p>
          </Panel>
        ))}
      </div>

      <div className="mt-8">
        <Panel className="p-5">
          <h2 className="text-[14.5px] font-semibold text-[var(--text)] mb-2">🔌 Kuidas see töötab (arhitektuur)</h2>
          <p className="text-[13px] leading-relaxed text-[var(--text-2)]">
            Veeb (Vercel) räägib Supabase andmebaasiga, mis toimib <b>sõnumisiinina</b>. Bridge (jookseb sinu serveris)
            pollib andmebaasi iga 5 sekundi järel, käivitab Hermese CLI ja peegeldab tulemused tagasi. Vercel ei puuduta
            kunagi otse Hermest — kõik läheb läbi Postgresi. Seega on süsteem turvaline: veeb on "nähtav", Hermes on
            "tegutseja", Postgres on vahendaja.
          </p>
        </Panel>
      </div>
    </div>
  );
}
