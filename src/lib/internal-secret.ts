import { timingSafeEqual } from "crypto";

/**
 * Constant-time compare so a secret cannot be guessed byte by byte.
 * Fail-closed: a missing expected or given value never matches.
 */
export function secretMatches(given: string | null, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Values that were public at some point (the old .env.example placeholder ran in prod 26.07–16.10).
const KNOWN_PLACEHOLDERS = new Set(["your-internal-api-secret"]);
const MIN_SECRET_LENGTH = 32;
let warnedWeakSecret = false;

/**
 * The configured INTERNAL_API_SECRET, or undefined when it is missing, too short or a known placeholder.
 * Fail-closed: a weak secret disables the header entirely instead of accepting a guessable value.
 */
export function internalSecret(): string | undefined {
  const value = process.env.INTERNAL_API_SECRET;
  if (!value) return undefined;
  if (value.length < MIN_SECRET_LENGTH || KNOWN_PLACEHOLDERS.has(value)) {
    if (!warnedWeakSecret) {
      warnedWeakSecret = true;
      // Never log the value itself, only why it was rejected.
      console.warn(
        `INTERNAL_API_SECRET rejected (${value.length < MIN_SECRET_LENGTH ? "shorter than 32 characters" : "known placeholder"}); x-internal-secret is disabled`,
      );
    }
    return undefined;
  }
  return value;
}

/**
 * Server-to-server auth with x-internal-secret (VPS scripts call it).
 * Fail-closed: no usable INTERNAL_API_SECRET configured => nothing is accepted.
 */
export function hasInternalSecret(req: Request): boolean {
  return secretMatches(req.headers.get("x-internal-secret"), internalSecret());
}

/**
 * Auth for /api/ingest/* (Argo pushes agent state). Separate secret from INTERNAL_API_SECRET,
 * so the ingest key can only write agent telemetry, not reach the other internal routes.
 */
export function hasIngestSecret(req: Request): boolean {
  return secretMatches(req.headers.get("x-ingest-secret"), process.env.INGEST_SECRET);
}
