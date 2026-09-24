import { timingSafeEqual } from "crypto";

/**
 * Server-to-server auth for the data-push routes under /api (VPS scripts call them).
 * Fail-closed: no INTERNAL_API_SECRET configured => nothing is accepted.
 * Constant-time compare so the secret cannot be guessed byte by byte.
 */
export function hasInternalSecret(req: Request): boolean {
  const expected = process.env.INTERNAL_API_SECRET;
  const given = req.headers.get("x-internal-secret");
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
