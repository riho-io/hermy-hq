import type { JobRow, RunDot } from '@/lib/jarvis';
import { TRACK_FUTURE_H, TRACK_PAST_H } from '@/lib/jarvis';
import { fmtTime, fmtWhen, tallinnHour } from './format';

const HOUR = 3_600_000;

const RUN_COLOR: Record<string, string> = {
  completed: 'var(--up)',
  failed: 'var(--down)',
  running: 'var(--accent)',
  claimed: 'var(--accent)',
};

// Every Argo job as one row on a shared 24 h axis: past runs as dots, the next run as a ring,
// a single "now" line through all rows. Reads like a train timetable for the agent.
export function DayTrack({ jobs, runs, now }: { jobs: JobRow[]; runs: RunDot[]; now: Date }) {
  const start = now.getTime() - TRACK_PAST_H * HOUR;
  const end = now.getTime() + TRACK_FUTURE_H * HOUR;
  const pct = (t: number) => ((t - start) / (end - start)) * 100;
  const nowPct = pct(now.getTime());

  // Gridlines on full hours (Tallinn offset is whole hours, so UTC hour boundaries line up).
  const ticks: { left: number; label: string | null }[] = [];
  for (let t = Math.ceil(start / HOUR) * HOUR; t <= end; t += HOUR) {
    const h = tallinnHour(new Date(t));
    ticks.push({ left: pct(t), label: h % 3 === 0 ? String(h).padStart(2, '0') : null });
  }

  const runsByJob = new Map<string, RunDot[]>();
  for (const r of runs) runsByJob.set(r.jobId, [...(runsByJob.get(r.jobId) ?? []), r]);

  return (
    <div className="relative">
      {/* axis */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,240px)_1fr] gap-x-6">
        <div className="hidden md:block" />
        <div className="relative h-6 text-[10.5px] num text-[var(--text-4)]" aria-hidden>
          {ticks.map((t, i) =>
            t.label ? (
              <span key={i} className="absolute -translate-x-1/2 bottom-1" style={{ left: `${t.left}%` }}>
                {t.label}
              </span>
            ) : null,
          )}
          <span
            className="absolute -translate-x-1/2 bottom-1 font-semibold text-[var(--accent)]"
            style={{ left: `${nowPct}%` }}
          >
            {fmtTime(now)}
          </span>
        </div>
      </div>

      <ul className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
        {jobs.map((job) => {
          const dots = runsByJob.get(job.id) ?? [];
          const nextT = job.nextRunAt?.getTime();
          const showNext = nextT !== undefined && nextT >= now.getTime() && nextT <= end;
          const paused = job.state !== 'scheduled';
          return (
            <li key={job.id} className="grid grid-cols-1 md:grid-cols-[minmax(0,240px)_1fr] gap-x-6 gap-y-2 py-2.5">
              <div className="min-w-0">
                <p
                  className={`truncate text-[13px] font-medium ${job.failing ? 'text-[var(--down)]' : paused ? 'text-[var(--text-3)]' : 'text-[var(--text)]'}`}
                  title={job.name}
                >
                  {job.name}
                </p>
                <p className="truncate text-[11.5px] num text-[var(--text-3)]">
                  {job.schedule}
                  {paused && ' · peatatud'}
                  {job.nextRunAt && !paused && ` · järgmine ${fmtWhen(job.nextRunAt, now)}`}
                </p>
              </div>

              <div className="relative h-7 self-center" role="img" aria-label={trackLabel(job, dots, now)}>
                {ticks.map((t, i) => (
                  <span
                    key={i}
                    className="absolute top-1 bottom-1 w-px"
                    style={{ left: `${t.left}%`, background: t.label ? 'var(--line-strong)' : 'var(--line)' }}
                  />
                ))}
                <span className="absolute top-0 bottom-0 w-px bg-[var(--accent)] opacity-70" style={{ left: `${nowPct}%` }} />
                {dots.map((d, i) => (
                  <span
                    key={i}
                    title={`${fmtWhen(d.at, now)} · ${d.status}`}
                    className="absolute top-1/2 h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{ left: `${pct(d.at.getTime())}%`, background: RUN_COLOR[d.status] ?? 'var(--text-3)' }}
                  />
                ))}
                {showNext && (
                  <span
                    title={`järgmine ${fmtTime(job.nextRunAt!)}`}
                    className="absolute top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--text-2)]"
                    style={{ left: `${pct(nextT!)}%` }}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function trackLabel(job: JobRow, dots: RunDot[], now: Date): string {
  const failed = dots.filter((d) => d.status === 'failed').length;
  const parts = [`${dots.length} jooksu viimase ${TRACK_PAST_H} tunni jooksul`];
  if (failed) parts.push(`${failed} ebaõnnestus`);
  if (job.nextRunAt) parts.push(`järgmine ${fmtWhen(job.nextRunAt, now)}`);
  return parts.join(', ');
}
