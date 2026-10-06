import { Eyebrow, Panel, Pill } from '@/components/ui/kit';
import { getJarvisData, TRACK_FUTURE_H, TRACK_PAST_H, type Source } from '@/lib/jarvis';
import { AutoRefresh } from './auto-refresh';
import { DayTrack } from './day-track';
import { fmtAgo, fmtHeading, fmtWhen } from './format';

// Live data on every request: Argo pushes every 5 min and the page must never show a cached state.
export const dynamic = 'force-dynamic';

const DOT: Record<Source['state'], string> = {
  ok: 'var(--up)',
  stale: 'var(--warn)',
  off: 'var(--text-4)',
};

export default async function JarvisPage() {
  const d = await getJarvisData();
  const { today, hermes, now } = d;
  const okCount = d.sources.filter((s) => s.state === 'ok').length;
  const staleCount = d.sources.filter((s) => s.state === 'stale').length;

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <AutoRefresh />

      <header className="hq-rise pt-4 pb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Jarvis</Eyebrow>
          <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.02em] text-[var(--text)] first-letter:uppercase">
            {fmtHeading(now)}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone="up">{okCount} korras</Pill>
          <Pill tone={staleCount ? 'warn' : 'neutral'}>{staleCount} aegunud</Pill>
        </div>
      </header>

      {/* TODAY — business numbers first, the agent comes after */}
      <section aria-label="Täna" className="hq-rise">
        <Panel className="grid grid-cols-2 lg:grid-cols-4 overflow-hidden">
          <TodayCell
            label="PML päringud täna"
            value={String(today.pmlInquiries)}
            sub={
              today.pmlLastAt
                ? `7 päevaga ${today.pmlLast7d} · viimane ${fmtWhen(today.pmlLastAt, now)}`
                : 'päringuid pole veel tulnud'
            }
            tone={today.pmlLastAt && now.getTime() - today.pmlLastAt.getTime() > 7 * 86_400_000 ? 'warn' : undefined}
          />
          <TodayCell label="dubly.me maksed täna" value="—" sub="Stripe ühendamata" muted className="border-l" />
          <TodayCell
            label="Kontode probleemid"
            value={String(today.kontoProblems)}
            sub={today.kontoProblems ? today.kontoProblemNames.join(', ') : 'kõik kontod korras'}
            tone={today.kontoProblems ? 'down' : undefined}
            href="/konto"
            className="border-t lg:border-t-0 lg:border-l"
          />
          <TodayCell label="Väljaminekud täna" value="—" sub="Sisumi kuluallikas lahtine" muted className="border-l border-t lg:border-t-0" />
        </Panel>
      </section>

      {/* CONNECTED — a source is green only if its last success landed inside its expected window */}
      <section aria-labelledby="sources-h" className="hq-rise mt-12">
        <div className="flex items-baseline justify-between gap-4 mb-4">
          <h2 id="sources-h" className="eyebrow">Ühendatud allikad</h2>
          <p className="text-[11.5px] text-[var(--text-3)]">roheline = viimane õnnestumine jäi oodatud aja sisse</p>
        </div>
        <ul className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
          {d.sources.map((s) => (
            <li key={s.key} className={`panel px-3.5 py-3 ${s.state === 'off' ? 'opacity-60' : ''}`}>
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: DOT[s.state] }} aria-hidden />
                <span className="truncate text-[13px] font-medium text-[var(--text)]">{s.label}</span>
              </div>
              <p className="mt-1 truncate text-[11.5px] text-[var(--text-3)]">
                <span className="sr-only">{s.state === 'ok' ? 'korras: ' : s.state === 'stale' ? 'aegunud: ' : 'ühendamata: '}</span>
                {s.note}
              </p>
              {s.lastOkAt && (
                <p className={`mt-0.5 text-[11.5px] num ${s.state === 'stale' ? 'text-[var(--warn)]' : 'text-[var(--text-4)]'}`}>
                  {fmtAgo(s.lastOkAt, now)}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* AGENT — the day track carries every job; the side card answers "what now?" */}
      <section className="hq-rise mt-12 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
        <Panel className="p-5 min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
            <h2 className="eyebrow">Päeva rada</h2>
            <p className="text-[11.5px] text-[var(--text-3)]">
              {TRACK_PAST_H} h tagasi kuni {TRACK_FUTURE_H} h ette ·{' '}
              <Legend color="var(--up)" label="õnnestus" /> <Legend color="var(--down)" label="ebaõnnestus" />{' '}
              <Legend ring label="järgmine" />
            </p>
          </div>
          {hermes.jobs.length ? (
            <DayTrack jobs={hermes.jobs} runs={d.runs} now={now} />
          ) : (
            <p className="py-10 text-center text-[13px] text-[var(--text-3)]">
              Argo pole veel ühtegi tööd saatnud. Kontrolli croni „hermy-hq sünk (Jarvis)” serveris.
            </p>
          )}
        </Panel>

        <Panel className="p-5 lg:sticky lg:top-4">
          <Eyebrow>Hermes · Argo</Eyebrow>
          <p className="mt-2 flex items-baseline gap-2">
            <span className="num text-[34px] font-semibold leading-none tracking-[-0.03em] text-[var(--text)]">
              {hermes.jobs.length}
            </span>
            <span className="text-[13px] text-[var(--text-2)]">ajastatud tööd</span>
          </p>
          <p className="mt-1 text-[11.5px] text-[var(--text-3)]">
            {hermes.reportedAt ? `andmed ${fmtAgo(hermes.reportedAt, now)}` : 'Argo pole veel raporteerinud'}
          </p>

          <dl className="mt-5 space-y-4 text-[13px]">
            <AgentFact label="Järgmine" name={hermes.next?.name} when={hermes.next?.nextRunAt} now={now} />
            <AgentFact label="Viimati tehtud" name={hermes.lastDone?.name} when={hermes.lastDone?.lastRunAt} now={now} />
            <div>
              <dt className="eyebrow">Praegu katki</dt>
              {hermes.failing.length ? (
                <dd className="mt-1.5 space-y-2.5">
                  {hermes.failing.map((j) => (
                    <div key={j.id}>
                      <p className="font-medium text-[var(--down)]">{j.name}</p>
                      <p className="text-[11.5px] text-[var(--text-3)]">
                        {j.failureStreak > 1 ? `${j.failureStreak} korda järjest · ` : ''}
                        {j.lastRunAt ? fmtWhen(j.lastRunAt, now) : ''}
                      </p>
                      {j.lastError && (
                        <p className="mt-0.5 line-clamp-2 text-[11.5px] text-[var(--text-2)]">{j.lastError}</p>
                      )}
                    </div>
                  ))}
                </dd>
              ) : (
                <dd className="mt-1.5 text-[var(--up)]">Ükski töö pole katki</dd>
              )}
            </div>
          </dl>
        </Panel>
      </section>
    </div>
  );
}

function TodayCell({
  label,
  value,
  sub,
  tone,
  muted,
  href,
  className = '',
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'down' | 'warn';
  muted?: boolean;
  href?: string;
  className?: string;
}) {
  const cell = `p-5 border-[var(--line)] ${className}`;
  const color = tone === 'down' ? 'var(--down)' : tone === 'warn' ? 'var(--warn)' : muted ? 'var(--text-4)' : 'var(--text)';
  const body = (
    <>
      <p className="eyebrow">{label}</p>
      <p className="mt-3 num text-[30px] font-semibold leading-none tracking-[-0.03em]" style={{ color }}>
        {value}
      </p>
      <p className="mt-2 line-clamp-2 text-[11.5px] text-[var(--text-3)]">{sub}</p>
    </>
  );
  return href ? (
    <a href={href} className={`block ${cell} hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)] transition-colors`}>
      {body}
    </a>
  ) : (
    <div className={cell}>{body}</div>
  );
}

function AgentFact({ label, name, when, now }: { label: string; name?: string; when?: Date | null; now: Date }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1.5">
        {name ? (
          <>
            <p className="font-medium text-[var(--text)]">{name}</p>
            {when && <p className="text-[11.5px] num text-[var(--text-3)]">{fmtWhen(when, now)}</p>}
          </>
        ) : (
          <p className="text-[var(--text-3)]">—</p>
        )}
      </dd>
    </div>
  );
}

function Legend({ color, ring, label }: { color?: string; ring?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <span
        className={`inline-block h-[7px] w-[7px] rounded-full ${ring ? 'border border-[var(--text-2)]' : ''}`}
        style={ring ? undefined : { background: color }}
        aria-hidden
      />
      {label}
    </span>
  );
}
