import { timingSafeEqual } from "crypto";

/**
 * Constant-time compare so a secret cannot be guessed byte by byte.
 * Fail-closed: a missing expected or given value never matches.
 */
function secretMatches(given: string | null, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Server-to-server auth for the data-push routes under /api (VPS scripts call them).
 * Fail-closed: no INTERNAL_API_SECRET configured => nothing is accepted.
 */
export function hasInternalSecret(req: Request): boolean {
  return secretMatches(req.headers.get("x-internal-secret"), process.env.INTERNAL_API_SECRET);
}

/**
 * Auth for /api/ingest/* (Argo pushes agent state). Separate secret from INTERNAL_API_SECRET,
 * so the ingest key can only write agent telemetry, not reach the other internal routes.
 */
export function hasIngestSecret(req: Request): boolean {
  return secretMatches(req.headers.get("x-ingest-secret"), process.env.INGEST_SECRET);
}
