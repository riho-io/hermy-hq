import { z } from 'zod';

// Single allowlist of Hermes actions the website may queue. The server-side
// executor keeps its own copy of this table; anything not listed is rejected.
export const ALLOWED_KINDS = {
  'cron.pause': { approval: false },
  'cron.resume': { approval: false },
  'cron.run': { approval: false },
  'cron.deliver': { approval: false },
  'cron.schedule': { approval: true },
} as const;

export type AllowedKind = keyof typeof ALLOWED_KINDS;

export const DELIVER_PRESETS = ['raport', 'hoiatus', 'vait'] as const;

export function isAllowed(kind: string): kind is AllowedKind {
  return Object.prototype.hasOwnProperty.call(ALLOWED_KINDS, kind);
}

// Unknown kinds fail closed: they would need approval (and are not allowed anyway).
export function requiresApproval(kind: string): boolean {
  return isAllowed(kind) ? ALLOWED_KINDS[kind].approval : true;
}

// Which decisions the requests PATCH route may apply to a row of this kind.
// approve: only kinds the executor knows. edit: never. It rewrites the prompt AND
// approves the row, so for cron.* rows it would bypass Zod validation and for
// any other kind it would bypass the approve check. Every executor kind is cron.*.
// reject: always, so old rows can be cleared.
export function decisionAllowed(kind: string, action: 'approve' | 'reject' | 'edit'): boolean {
  if (action === 'reject') return true;
  if (action === 'approve') return isAllowed(kind);
  return false;
}

export const jobIdSchema = z.string().regex(/^[0-9a-f]{12}$/);
// Must start alphanumeric so the value can never be read as a CLI flag.
export const profileSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
export const presetSchema = z.enum(DELIVER_PRESETS);
export const scheduleSchema = z.string().min(1).max(64).regex(/^[0-9a-z*/,][0-9a-z*/, -]*$/);

export type DeliverState = (typeof DELIVER_PRESETS)[number] | 'muu';

// Maps a job's raw deliver/failure_deliver targets to the preset name the UI shows.
// The raw values contain chat ids and must never reach the browser; only this name does.
export function deliverPreset(deliver: string | null, failureDeliver: string | null): DeliverState {
  const tg = (v: string | null) => v !== null && v.startsWith('telegram');
  const local = (v: string | null) => v === null || v === '' || v === 'local';
  if (tg(deliver)) return 'hoiatus';
  if (local(deliver) && tg(failureDeliver)) return 'raport';
  if (local(deliver) && failureDeliver === 'local') return 'vait';
  return 'muu';
}

// Error text from Argo can quote deliver targets; chat ids stay on the server.
export function maskChatIds<T extends string | null>(text: T): T {
  return (text === null ? null : text.replace(/telegram:[^\s,]+/g, 'telegram:***')) as T;
}
