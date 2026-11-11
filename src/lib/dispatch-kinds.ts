// Kinds /api/hermes/dispatch may queue. No `cron.*` here: cron ops go only
// through /api/hermes/crons (Zod-validated jobId/profile). Approval decisions
// come from requiresApproval() in hermes-actions.ts (single source).
// Empty: the executor supports none of the non-cron kinds yet, so dispatch
// refuses everything until a kind is added here together with executor support.
const DISPATCH_KINDS = new Set<string>();

export function dispatchAccepts(kind: string): boolean {
  return DISPATCH_KINDS.has(kind);
}
