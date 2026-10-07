import { summarizeWiki, type WikiGraph, type WikiNote } from '@/lib/wiki-graph';
import { prisma } from '@/lib/prisma';

// Data for the /jarvis page. Read-only; everything here is written by Argo (ingest) or other apps.

export type SourceState = 'ok' | 'stale' | 'off';

export interface Source {
  key: string;
  label: string;
  state: SourceState;
  /** Last time the source delivered successfully; null when never or not connected. */
  lastOkAt: Date | null;
  /** Shown under the label: why it is stale/off, or what it reports. */
  note: string;
}

export interface JobRow {
  id: string;
  name: string;
  schedule: string;
  state: string;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  failureStreak: number;
  nextRunAt: Date | null;
  failing: boolean;
}

export interface RunDot {
  jobId: string;
  at: Date;
  status: string;
}

/** Timeline window around "now" for the day track. */
export const TRACK_PAST_H = 18;
export const TRACK_FUTURE_H = 6;

export interface JarvisData {
  now: Date;
  runs: RunDot[];
  today: {
    pmlInquiries: number;
    pmlLast7d: number;
    pmlLastAt: Date | null;
    kontoProblems: number;
    kontoProblemNames: string[];
  };
  sources: Source[];
  hermes: {
    reportedAt: Date | null;
    jobs: JobRow[];
    next: JobRow | null;
    lastDone: JobRow | null;
    failing: JobRow[];
  };
  wiki: null | {
    graph: WikiGraph;
    counts: { notes: number; links: number; unresolved: number; orphans: number };
    recent: WikiNote[];
    changedToday: number;
    generatedAt: Date;
    pcLastSeenAt: Date | null;
  };
}

const MIN = 60_000;

// A source is "ok" when its last success is inside its expected window (Jay's rule).
function windowState(lastOkAt: Date | null, expectedMin: number, now: Date): SourceState {
  if (!lastOkAt) return 'stale';
  return now.getTime() - lastOkAt.getTime() <= expectedMin * MIN ? 'ok' : 'stale';
}

interface KontoPayload {
  checks?: { name?: string; status?: string }[];
  problems_count?: number;
}

export async function getJarvisData(): Promise<JarvisData> {
  const now = new Date();

  const [heartbeat, jobs, runs, konto, sites, pmlRows, wikiRow, wikiBeat] = await Promise.all([
    prisma.sourceHeartbeat.findUnique({ where: { source: 'hermes' } }),
    prisma.agentJob.findMany({ where: { source: 'argo' } }),
    prisma.agentJobRun.findMany({
      where: { source: 'argo', startedAt: { gte: new Date(now.getTime() - TRACK_PAST_H * 60 * MIN) } },
      select: { jobId: true, startedAt: true, status: true },
    }),
    prisma.kontoCheck.findUnique({ where: { id: 'latest' } }),
    prisma.kontoCheck.findUnique({ where: { id: 'sites' } }),
    prisma.$queryRaw<{ today: number; last_7d: number; last_at: Date | null }[]>`
      SELECT today, last_7d, last_at FROM hermyhq.jarvis_pml_inquiry_stats`,
    prisma.wikiSnapshot.findUnique({ where: { source: 'wiki' } }),
    prisma.sourceHeartbeat.findUnique({ where: { source: 'wiki' } }),
  ]);

  const pml = pmlRows[0] ?? { today: 0, last_7d: 0, last_at: null };
  const kontoPayload = (konto?.payload ?? {}) as KontoPayload;
  const sitesPayload = (sites?.payload ?? {}) as KontoPayload;
  const kontoProblemNames = (kontoPayload.checks ?? [])
    .filter((c) => c.status === 'problem')
    .map((c) => c.name ?? 'tundmatu');

  const rows: JobRow[] = jobs.map((j) => ({
    id: j.id,
    name: j.name,
    schedule: j.schedule,
    state: j.state,
    lastRunAt: j.lastRunAt,
    lastStatus: j.lastStatus,
    lastError: j.lastError,
    failureStreak: j.failureStreak,
    nextRunAt: j.nextRunAt,
    failing: (j.lastStatus !== null && j.lastStatus !== 'ok') || j.failureStreak > 0,
  }));
  rows.sort((a, b) => (a.nextRunAt?.getTime() ?? Infinity) - (b.nextRunAt?.getTime() ?? Infinity));

  const active = rows.filter((r) => r.state === 'scheduled');
  const next = active.find((r) => r.nextRunAt && r.nextRunAt >= now) ?? null;
  const lastDone =
    rows
      .filter((r) => r.lastStatus === 'ok' && r.lastRunAt)
      .sort((a, b) => b.lastRunAt!.getTime() - a.lastRunAt!.getTime())[0] ?? null;

  const kontoProblems = kontoPayload.problems_count ?? kontoProblemNames.length;
  const sitesProblems = sitesPayload.problems_count ?? 0;

  const wikiGraph = (wikiRow?.graph ?? null) as WikiGraph | null;
  const wiki = wikiRow && wikiGraph
    ? {
        graph: wikiGraph,
        counts: {
          notes: wikiRow.noteCount,
          links: wikiRow.linkCount,
          unresolved: wikiRow.unresolvedCount,
          orphans: wikiRow.orphanCount,
        },
        ...summarizeWiki(wikiGraph, now),
        generatedAt: wikiRow.generatedAt,
        pcLastSeenAt: wikiRow.pcLastSeenAt,
      }
    : null;

  const sources: Source[] = [
    {
      key: 'hermes',
      label: 'Hermes · Argo',
      state: windowState(heartbeat?.lastOkAt ?? null, heartbeat?.expectedEveryMin ?? 15, now),
      lastOkAt: heartbeat?.lastOkAt ?? null,
      note: `${rows.length} tööd`,
    },
    {
      key: 'konto',
      label: 'Kontojälgija',
      // konto_check runs every 6 h on Argo; one missed run is tolerated.
      state: windowState(konto?.checkedAt ?? null, 13 * 60, now),
      lastOkAt: konto?.checkedAt ?? null,
      note: kontoProblems ? `${kontoProblems} probleem` : 'kõik korras',
    },
    {
      key: 'sites',
      label: 'Kodulehed',
      state: windowState(sites?.checkedAt ?? null, 13 * 60, now),
      lastOkAt: sites?.checkedAt ?? null,
      note: sitesProblems ? `${sitesProblems} maas` : 'kõik üleval',
    },
    {
      key: 'pml',
      label: 'PML päringud',
      // Inquiries arrive from riho@pml.ee; a week without one means the pipeline likely stopped.
      state: windowState(pml.last_at, 7 * 24 * 60, now),
      lastOkAt: pml.last_at,
      note: 'riho@pml.ee postkast',
    },
    { key: 'stripe', label: 'Stripe · dubly.me', state: 'off', lastOkAt: null, note: 'ühendamata (etapp 4)' },
    { key: 'sisum-kulud', label: 'Sisum kulud', state: 'off', lastOkAt: null, note: 'allikas lahtine' },
    {
      key: 'wiki',
      label: 'Wiki',
      // Argo pushes hourly; the window allows ~3 missed runs.
      state: wikiBeat ? windowState(wikiBeat.lastOkAt, wikiBeat.expectedEveryMin, now) : 'off',
      lastOkAt: wikiBeat?.lastOkAt ?? null,
      note: wiki
        ? `${wiki.counts.notes} märget · PC ${wiki.pcLastSeenAt ? `sünkis ${fmtAgoShort(wiki.pcLastSeenAt, now)}` : 'pole näha'}`
        : 'ühendamata',
    },
  ];

  return {
    now,
    runs: runs.flatMap((r) => (r.startedAt ? [{ jobId: r.jobId, at: r.startedAt, status: r.status }] : [])),
    today: {
      pmlInquiries: pml.today,
      pmlLast7d: pml.last_7d,
      pmlLastAt: pml.last_at,
      kontoProblems,
      kontoProblemNames,
    },
    sources,
    hermes: {
      reportedAt: heartbeat?.lastOkAt ?? null,
      jobs: rows,
      next,
      lastDone,
      failing: rows.filter((r) => r.failing),
    },
    wiki,
  };
}

function fmtAgoShort(d: Date, now: Date): string {
  const min = Math.round((now.getTime() - d.getTime()) / MIN);
  if (min < 60) return `${Math.max(min, 0)} min tagasi`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h tagasi` : `${Math.round(h / 24)} p tagasi`;
}
