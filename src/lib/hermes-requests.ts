import { z } from 'zod';
import { ALLOWED_KINDS, isAllowed, requiresApproval, jobIdSchema, profileSchema, presetSchema, scheduleSchema, type AllowedKind } from './hermes-actions';

// Pure logic for the executor API (/api/ingest/hermes-requests). Cron rows keep
// {jobId, profile, preset|schedule} as JSON in AgentRequest.prompt.

const base = { jobId: jobIdSchema, profile: profileSchema };
const PAYLOAD_SCHEMAS: Record<AllowedKind, z.ZodType<Record<string, string>>> = {
  'cron.pause': z.object(base).strict(),
  'cron.resume': z.object(base).strict(),
  'cron.run': z.object(base).strict(),
  'cron.deliver': z.object({ ...base, preset: presetSchema }).strict(),
  'cron.schedule': z.object({ ...base, schedule: scheduleSchema }).strict(),
};

// Kinds that may start from status "queued" (no approval step).
export const NON_APPROVAL_KINDS = (Object.keys(ALLOWED_KINDS) as AllowedKind[]).filter((k) => !ALLOWED_KINDS[k].approval);

export function parsePayload(kind: string, prompt: string | null): Record<string, string> | null {
  if (!isAllowed(kind) || !prompt) return null;
  let json: unknown;
  try {
    json = JSON.parse(prompt);
  } catch {
    return null;
  }
  const r = PAYLOAD_SCHEMAS[kind].safeParse(json);
  return r.success ? r.data : null;
}

export type RowVerdict =
  | { action: 'skip' }
  | { action: 'reject'; error: string }
  | { action: 'return'; payload: Record<string, string> };

// Runnable = (queued AND no approval needed) OR approved.
export function classifyRow(row: { kind: string; status: string; prompt: string | null }): RowVerdict {
  const runnable = (row.status === 'queued' && !requiresApproval(row.kind)) || row.status === 'approved';
  // Unknown kinds fail closed in requiresApproval(), so only "approved" ones reach this point;
  // a queued unknown row belongs to some other feature and is left alone.
  if (!runnable) return { action: 'skip' };
  if (!isAllowed(row.kind)) return { action: 'reject', error: 'not supported by the executor' };
  const payload = parsePayload(row.kind, row.prompt);
  return payload ? { action: 'return', payload } : { action: 'reject', error: 'invalid payload' };
}

export type ReportStatus = 'running' | 'done' | 'failed';

// Statuses a row must currently have for the move to `to` (goes into the WHERE clause).
export function fromStatuses(to: ReportStatus): string[] {
  return to === 'running' ? ['queued', 'approved'] : ['running'];
}

export function canTransition(from: string, to: ReportStatus, kind: string): boolean {
  if (!fromStatuses(to).includes(from)) return false;
  if (to === 'running' && from === 'queued') return !requiresApproval(kind);
  return true;
}

// `?ids=` for GET /api/hermes/requests: null when absent, 'invalid' when malformed.
const CUIDISH = /^[a-z0-9]{1,40}$/;
export const MAX_IDS = 20;
export function parseIdsParam(raw: string | null): string[] | null | 'invalid' {
  if (raw === null) return null;
  const ids = raw.split(',');
  if (ids.length > MAX_IDS || !ids.every((id) => CUIDISH.test(id))) return 'invalid';
  return ids;
}
