import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Eyebrow, Panel, EmptyState } from '@/components/ui/kit';
import { getReport, getReportJobs, getReportList } from '@/lib/reports';
import { fmtAgo, fmtWhen } from '@/app/(jarvis)/format';
import { ReportBody } from './report-body';

// New reports arrive within 5 min of a cron run; never serve a cached list.
export const dynamic = 'force-dynamic';

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REPORT_ID = /^[A-Za-z0-9_-]{1,64}\/[0-9_-]{19}$/;

const fullFmt = new Intl.DateTimeFormat('et-EE', {
  timeZone: 'Europe/Tallinn',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function href(job: string | null, id?: string) {
  const q = new URLSearchParams();
  if (job) q.set('job', job);
  if (id) q.set('id', id);
  const s = q.toString();
  return s ? `/raportid?${s}` : '/raportid';
}

export default async function RaportidPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; id?: string }>;
}) {
  // proxy.ts already redirects visitors without a session; this keeps the page closed if the matcher ever misses it.
  if (process.env.NODE_ENV !== 'development' && !(await getServerSession(authOptions))) redirect('/login');

  const sp = await searchParams;
  const job = sp.job && JOB_ID.test(sp.job) ? sp.job : null;
  const wantedId = sp.id && REPORT_ID.test(sp.id) ? sp.id : null;

  const [jobs, list] = await Promise.all([getReportJobs(), getReportList(job)]);
  const selectedId = wantedId ?? list[0]?.id ?? null;
  const report = selectedId ? await getReport(selectedId) : null;
  const now = new Date();

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <header className="hq-rise pt-4 pb-8">
        <Eyebrow>Argo</Eyebrow>
        <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">Raportid</h1>
        <p className="text-[13.5px] text-[var(--text-3)] mt-3 max-w-[65ch]">
          Cronide raportid täies pikkuses. Telegrami tuleb sama tekst, siin jääb see alles ja on kuupäeva järgi leitav.
        </p>
      </header>

      {jobs.length === 0 ? (
        <EmptyState title="Raporteid pole veel" hint="Argo saadab need järgmise sünkiga (iga 5 min)." />
      ) : (
        <>
          <nav aria-label="Cronid" className="flex flex-wrap gap-2 mb-8">
            <Link
              href={href(null)}
              className={`px-3 py-1.5 rounded-full text-[12.5px] border ${!job ? 'border-[var(--accent)] text-[var(--text)]' : 'border-[var(--line)] text-[var(--text-3)] hover:text-[var(--text)]'}`}
            >
              Kõik
            </Link>
            {jobs.map((j) => (
              <Link
                key={j.jobId}
                href={href(j.jobId)}
                className={`px-3 py-1.5 rounded-full text-[12.5px] border ${job === j.jobId ? 'border-[var(--accent)] text-[var(--text)]' : 'border-[var(--line)] text-[var(--text-3)] hover:text-[var(--text)]'}`}
              >
                {j.jobName} <span className="text-[var(--text-4)]">· {j.count}</span>
              </Link>
            ))}
          </nav>

          <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] items-start">
            <Panel className="p-2 lg:sticky lg:top-4 max-h-[40vh] lg:max-h-[80vh] overflow-y-auto">
              <ul>
                {list.map((r) => {
                  const active = r.id === selectedId;
                  return (
                    <li key={r.id}>
                      <Link
                        href={href(job, r.id)}
                        aria-current={active ? 'page' : undefined}
                        className={`block rounded-lg px-3 py-2.5 ${active ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]'}`}
                      >
                        <span className="block text-[13px] text-[var(--text)]">{fmtWhen(r.runAt, now)}</span>
                        {!job && <span className="block text-[12px] text-[var(--text-3)] truncate">{r.jobName}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Panel>

            {report ? (
              <Panel className="p-6 sm:p-8">
                <article>
                  <p className="text-[12px] uppercase tracking-[0.08em] text-[var(--text-3)]">{report.jobName}</p>
                  <p className="mt-1 text-[13px] text-[var(--text-3)]">
                    {fullFmt.format(report.runAt)} · {fmtAgo(report.runAt, now)}
                  </p>
                  <div className="mt-6 max-w-[75ch]">
                    <ReportBody text={report.body} />
                  </div>
                </article>
              </Panel>
            ) : (
              <EmptyState title="Raportit ei leitud" hint="See jooks on kustunud või link on vale." />
            )}
          </div>
        </>
      )}
    </div>
  );
}
