import 'server-only';
import { unstable_cache } from 'next/cache';
import { readDublyStripe, type RevenueSummary } from '@/lib/stripe-read';

// SERVER ONLY. Holds the dubly.me (Sisum OÜ) restricted Stripe key; never import into client code.
// The page refreshes every 60 s, Stripe is asked at most every 10 min.

export type DublyRevenue =
  | { state: 'off' }
  | { state: 'error' }
  | { state: 'ok'; summary: RevenueSummary; fetchedAt: string };

const cachedRead = unstable_cache(
  async () => {
    const now = new Date();
    // A throw is not cached. After expiry Next serves the stale value while refreshing in the background and
    // swallows background errors, so the caller judges staleness from fetchedAt, not from state alone.
    const summary = await readDublyStripe(process.env.STRIPE_DUBLY_READ_KEY ?? '', now);
    return { summary, fetchedAt: now.toISOString() };
  },
  ['dubly-stripe-revenue-v2'],
  { revalidate: 600 },
);

export async function getDublyRevenue(): Promise<DublyRevenue> {
  if (!process.env.STRIPE_DUBLY_READ_KEY) return { state: 'off' };
  try {
    return { state: 'ok', ...(await cachedRead()) };
  } catch (err) {
    // Message carries only the Stripe path + HTTP status (see stripe-read.ts), never the key.
    console.error('stripe-dubly read failed', err instanceof Error ? err.message : 'unknown');
    return { state: 'error' };
  }
}
