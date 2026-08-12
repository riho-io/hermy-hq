"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, RefreshCw, Check, X } from "lucide-react";
import { Panel, SectionHeader, Eyebrow, Skeleton } from "@/components/ui/kit";

interface Channel { name: string; configured: boolean; note?: string }

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/hermes/channels");
      if (r.ok) {
        const d = await r.json();
        setChannels(d.channels ?? []);
      }
    } catch { /* offline */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <div className="hq-rise pt-4 pb-8 flex items-end justify-between gap-4">
        <div>
          <Eyebrow>Suhtluskanalid</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
            Kanalid
          </h1>
          <p className="text-[13.5px] text-[var(--text-3)] mt-2 max-w-[65ch]">
            Räägi oma agentidega kõikjal: Telegram, Discord, WhatsApp, Slack. Ühenda kanal — ja Hermes vastab seal, kus sina oled.
          </p>
        </div>
        <button type="button" onClick={load} aria-label="Värskenda" className="btn-ghost inline-flex items-center justify-center w-9 h-9">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {channels.map((ch) => (
            <Panel key={ch.name} className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${ch.configured ? "bg-[color-mix(in_srgb,var(--up)_12%,transparent)]" : "bg-white/[0.05]"}`}>
                    <MessageSquare className="w-4 h-4" style={{ color: ch.configured ? "var(--up)" : "var(--text-3)" }} />
                  </span>
                  <h2 className="text-[15px] font-semibold text-[var(--text)]">{ch.name}</h2>
                </div>
                <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full ${ch.configured ? "text-[var(--up)] bg-[color-mix(in_srgb,var(--up)_10%,transparent)]" : "text-[var(--text-3)] bg-white/[0.05]"}`}>
                  {ch.configured ? <><Check className="w-3 h-3" /> ühendatud</> : <><X className="w-3 h-3" /> pole ühendatud</>}
                </span>
              </div>
              <p className="text-[12.5px] leading-relaxed text-[var(--text-3)]">
                {ch.note || (ch.configured
                  ? "See kanal on seadistatud — saad saata sõnumeid ja Hermes vastab siin."
                  : "Seadistamata. Vaata Hermese dokumentatsiooni, kuidas see kanal ühendada.")}
              </p>
            </Panel>
          ))}
        </div>
      )}

      <div className="mt-8">
        <Panel className="p-5">
          <h2 className="text-[14.5px] font-semibold text-[var(--text)] mb-2">📱 Kuidas kanalitega rääkida</h2>
          <p className="text-[13px] leading-relaxed text-[var(--text-2)]">
            Kui kanal on ühendatud (roheline märgis), ava selle vestlus ja kirjuta otse — Hermes vastab seal, kus sa parasjagu oled.
            Discordi/WhatsAppi/Slacki ühendamiseks kasuta <code className="num">hermes setup</code> oma serveris — iga kanal vajab oma bot-tokenit.
          </p>
        </Panel>
      </div>
    </div>
  );
}
