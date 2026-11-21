import { NextResponse } from 'next/server'
import { verifySvix } from '@/lib/bills/svix'
import { processInbound } from '@/lib/bills/inbound'
import { io, store } from '@/lib/bills/adapters'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
const MAX_BYTES = 200_000

// Resend "email.received" webhook. Auth = Svix signature (not a session): verified on the RAW body
// before anything touches the database.
export async function POST(req: Request) {
  const body = await req.text()
  if (Buffer.byteLength(body) > MAX_BYTES) return NextResponse.json({ error: 'Too large' }, { status: 413 })

  const ok = verifySvix({
    secret: process.env.RESEND_WEBHOOK_SECRET,
    id: req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
    body,
  })
  if (!ok) return NextResponse.json({ error: 'Bad signature' }, { status: 400 })

  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }
  try {
    const outcome = await processInbound(json, store, io, { ownAddress: process.env.BILLS_INBOUND_ADDRESS })
    return NextResponse.json({ ok: true, outcome })
  } catch (err) {
    // Only reachable when the claim itself failed (DB down): 500 makes Resend retry.
    console.error('inbound/resend failed', err instanceof Error ? err.message : 'unknown')
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
