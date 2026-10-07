// dubly.me revenue from Stripe (Sisum OÜ). Pure: no env, no Next — the caller passes the key and fetch.
// Only aggregates leave this module's summary; customer ids, names, emails and descriptions are never copied.

const API = 'https://api.stripe.com/v1';
const TZ = 'Europe/Tallinn';
const MAX_PAGES = 20;
const RECENT_LIMIT = 10;

export type Money = Record<string, number>; // currency -> minor units

export interface StripeTxn {
  id: string;
  reporting_category: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  created: number; // unix seconds
}

export interface StripeSub {
  id?: string; // only used for pagination cursors
  status: string;
  canceled_at: number | null;
  items: {
    data: {
      quantity?: number | null;
      price: {
        unit_amount: number | null;
        currency: string;
        recurring: { interval: 'day' | 'week' | 'month' | 'year'; interval_count: number } | null;
      };
    }[];
  };
}

export interface Period {
  count: number;
  gross: Money;
  net: Money;
}

export interface RecentTxn {
  id: string;
  kind: 'payment' | 'refund' | 'dispute';
  amount: number;
  net: number;
  currency: string;
  at: string; // ISO
}

export interface RevenueSummary {
  today: { count: number; net: Money };
  thisMonth: Period;
  prevMonth: Period;
  mrr: Money;
  activeSubs: number;
  canceledThisMonth: number;
  recent: RecentTxn[];
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// Which balance-transaction categories count as revenue, and how they are labelled.
// Reversals carry their own (positive) sign, so a won dispute or a failed refund gives the money back.
const KIND: Record<string, RecentTxn['kind']> = {
  charge: 'payment',
  refund: 'refund',
  refund_failure: 'refund',
  dispute: 'dispute',
  dispute_reversal: 'dispute',
};

// Months as fractions of a month, for MRR.
const PER_MONTH: Record<string, number> = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 };

const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' });

function tallinnOffsetMin(at: Date): number {
  const name = offsetFmt.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

// Midnight in Tallinn as a UTC instant (DST switches at 03:00/04:00 local, never at midnight).
function tallinnMidnight(y: number, m: number, d: number): Date {
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - tallinnOffsetMin(guess) * 60_000);
}

export function tallinnBounds(now: Date) {
  const [y, m, d] = ymd.format(now).split('-').map(Number);
  return {
    todayStart: tallinnMidnight(y, m, d),
    thisMonthStart: tallinnMidnight(y, m, 1),
    prevMonthStart: m === 1 ? tallinnMidnight(y - 1, 12, 1) : tallinnMidnight(y, m - 1, 1),
  };
}

const add = (money: Money, currency: string, minor: number) => {
  money[currency] = (money[currency] ?? 0) + minor;
};
const emptyPeriod = (): Period => ({ count: 0, gross: {}, net: {} });

export function summarizeRevenue(txns: StripeTxn[], liveSubs: StripeSub[], canceledSubs: StripeSub[], now: Date): RevenueSummary {
  const { todayStart, thisMonthStart, prevMonthStart } = tallinnBounds(now);
  const today = { count: 0, net: {} as Money };
  const thisMonth = emptyPeriod();
  const prevMonth = emptyPeriod();
  const revenue = txns.filter((t) => KIND[t.reporting_category] && t.created * 1000 >= prevMonthStart.getTime());

  for (const t of revenue) {
    const at = t.created * 1000;
    const period = at >= thisMonthStart.getTime() ? thisMonth : prevMonth;
    const isPayment = t.reporting_category === 'charge';
    if (isPayment) period.count += 1;
    add(period.gross, t.currency, t.amount);
    add(period.net, t.currency, t.net);
    if (at >= todayStart.getTime()) {
      if (isPayment) today.count += 1;
      add(today.net, t.currency, t.net);
    }
  }

  const mrr: Money = {};
  for (const s of liveSubs) {
    for (const item of s.items.data) {
      const { unit_amount, currency, recurring } = item.price;
      if (!unit_amount || !recurring) continue;
      add(mrr, currency, (unit_amount * (item.quantity ?? 1) * PER_MONTH[recurring.interval]) / recurring.interval_count);
    }
  }
  for (const c of Object.keys(mrr)) mrr[c] = Math.round(mrr[c]);

  const recent = [...revenue]
    .sort((a, b) => b.created - a.created)
    .slice(0, RECENT_LIMIT)
    .map((t) => ({
      id: t.id,
      kind: KIND[t.reporting_category],
      amount: t.amount,
      net: t.net,
      currency: t.currency,
      at: new Date(t.created * 1000).toISOString(),
    }));

  return {
    today,
    thisMonth,
    prevMonth,
    mrr,
    activeSubs: liveSubs.length,
    canceledThisMonth: canceledSubs.filter((s) => s.canceled_at && s.canceled_at * 1000 >= thisMonthStart.getTime()).length,
    recent,
  };
}

async function listAll<T extends { id?: string }>(path: string, params: Record<string, string>, key: string, f: FetchLike): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ ...params, limit: '100', ...(after ? { starting_after: after } : {}) });
    const res = await f(`${API}${path}?${q}`, { headers: { Authorization: `Bearer ${key}` } });
    // Only path + status in the message: never the key or the response body.
    if (!res.ok) throw new Error(`Stripe ${path} HTTP ${res.status}`);
    const body = (await res.json()) as { data: T[]; has_more: boolean };
    out.push(...body.data);
    if (!body.has_more || body.data.length === 0) return out;
    after = (body.data[body.data.length - 1] as { id?: string }).id;
  }
  // A silently partial sum would be worse than an error.
  throw new Error(`Stripe ${path}: more than ${MAX_PAGES} pages`);
}

export async function readDublyStripe(key: string, now: Date, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<RevenueSummary> {
  // Read-only restricted keys start with rk_; a full secret key must never be used here.
  if (!key.startsWith('rk_')) throw new Error('STRIPE_DUBLY_READ_KEY must be a restricted (rk_) key');
  const { prevMonthStart } = tallinnBounds(now);
  const since = String(Math.floor(prevMonthStart.getTime() / 1000));
  const [txns, active, pastDue, canceled] = await Promise.all([
    listAll<StripeTxn>('/balance_transactions', { 'created[gte]': since }, key, fetchImpl),
    listAll<StripeSub>('/subscriptions', { status: 'active' }, key, fetchImpl),
    listAll<StripeSub>('/subscriptions', { status: 'past_due' }, key, fetchImpl),
    listAll<StripeSub>('/subscriptions', { status: 'canceled' }, key, fetchImpl),
  ]);
  return summarizeRevenue(txns, [...active, ...pastDue], canceled, now);
}
