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

export const jobIdSchema = z.string().regex(/^[0-9a-f]{12}$/);
// Must start alphanumeric so the value can never be read as a CLI flag.
export const profileSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
export const presetSchema = z.enum(DELIVER_PRESETS);
export const scheduleSchema = z.string().min(1).max(64).regex(/^[0-9a-z*/,][0-9a-z*/, -]*$/);
