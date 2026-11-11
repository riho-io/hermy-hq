// Kinds /api/hermes/dispatch may queue. No `cron.*` here: cron ops go only
// through /api/hermes/crons (Zod-validated jobId/profile). Approval decisions
// come from requiresApproval() in hermes-actions.ts (single source).
const DISPATCH_KINDS = new Set([
  "kanban",
  "goal",
  "briefing.generate",
  "model.set",
  "journey.fetch",
]);

export function dispatchAccepts(kind: string): boolean {
  return DISPATCH_KINDS.has(kind);
}
