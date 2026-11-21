import { createHmac, timingSafeEqual } from 'node:crypto'

export const SVIX_TOLERANCE_SEC = 300

/**
 * Verifies a Svix-signed webhook (Resend). Needs ALL of: valid signature over `${id}.${timestamp}.${rawBody}`,
 * timestamp within ±300 s, constant-time compare. The header may carry several space-separated signatures
 * (key rotation); any valid v1 one passes. Fail-closed on any missing input.
 */
export function verifySvix(o: {
  secret: string | undefined
  id: string | null
  timestamp: string | null
  signature: string | null
  body: string
  nowSec?: number
}): boolean {
  const { secret, id, timestamp, signature, body } = o
  if (!secret || !id || !timestamp || !signature) return false
  const ts = Number(timestamp)
  const now = o.nowSec ?? Math.floor(Date.now() / 1000)
  if (!Number.isInteger(ts) || Math.abs(now - ts) > SVIX_TOLERANCE_SEC) return false
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64')
  if (key.length === 0) return false
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest()
  let ok = false
  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig) continue
    const given = Buffer.from(sig, 'base64')
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true
  }
  return ok
}
