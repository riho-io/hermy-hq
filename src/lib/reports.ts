import 'server-only';
import { prisma } from '@/lib/prisma';

// Data for the /raportid page. Read-only; rows are written by Argo via /api/ingest/hermes-report.

export interface ReportJob {
  jobId: string;
  jobName: string;
  count: number;
  lastRunAt: Date;
}

export interface ReportListItem {
  id: string;
  jobId: string;
  jobName: string;
  runAt: Date;
}

export interface Report extends ReportListItem {
  body: string;
}

const LIST_LIMIT = 60;

export async function getReportJobs(): Promise<ReportJob[]> {
  const groups = await prisma.agentReport.groupBy({
    by: ['jobId'],
    _count: { _all: true },
    _max: { runAt: true },
    orderBy: { _max: { runAt: 'desc' } },
  });
  // The newest row carries the current job name (a job can be renamed on Argo).
  const latest = await prisma.agentReport.findMany({
    where: { jobId: { in: groups.map((g) => g.jobId) } },
    distinct: ['jobId'],
    orderBy: { runAt: 'desc' },
    select: { jobId: true, jobName: true },
  });
  const names = new Map(latest.map((r) => [r.jobId, r.jobName]));
  return groups.map((g) => ({
    jobId: g.jobId,
    jobName: names.get(g.jobId) ?? g.jobId,
    count: g._count._all,
    lastRunAt: g._max.runAt!,
  }));
}

export async function getReportList(jobId: string | null): Promise<ReportListItem[]> {
  return prisma.agentReport.findMany({
    where: jobId ? { jobId } : undefined,
    orderBy: { runAt: 'desc' },
    take: LIST_LIMIT,
    select: { id: true, jobId: true, jobName: true, runAt: true },
  });
}

export async function getReport(id: string): Promise<Report | null> {
  return prisma.agentReport.findUnique({
    where: { id },
    select: { id: true, jobId: true, jobName: true, runAt: true, body: true },
  });
}
