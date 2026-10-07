# dubly.me tulud Jarvises — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jarvis näitab dubly.me Stripe tulu: maksed täna, see/eelmine kuu (neto, bruto), MRR, tellijad, tühistused, viimased maksed.

**Architecture:** Jarvise server küsib Stripe REST-ilt (ainult lugemisõigusega võti Vercelis), arvutab koondi puhta funktsiooniga ja hoiab tulemust 10 min `unstable_cache`-is. Lehele jõuavad ainult koondarvud.

**Tech Stack:** Next.js 16.1.6 App Router, React 19, TypeScript, `node:test` + `tsx`, Stripe REST v1 (ilma SDK-ta), `server-only`.

Spec: `docs/superpowers/specs/2026-10-07-dubly-revenue-design.md`.

## Global Constraints

- Võti `STRIPE_DUBLY_READ_KEY` ainult serveris (Vercel, sensitive). Mitte `NEXT_PUBLIC_`, mitte logis, mitte veateates.
- `sk_` algusega võtit ei kasutata (ainult restricted `rk_`).
- Kliendi ID-d, nimed, e-postid ja Stripe `description` ei lähe lehele ega kliendikomponenti.
- Päeva-/kuupiirid Tallinna aja järgi (`Europe/Tallinn`).
- Raha täisarvudena (sendid) kuni kuvamiseni; valuutad eraldi, kokku ei liideta.
- Repo AVALIK: koodis ei võtit ega konto ID-d.
- Kood/kommentaarid inglise keeles, UI eesti keeles; Tailwind `var(--token)` klassid nagu `src/app/(jarvis)/page.tsx`-is. LF reavahetused.
- npm (mitte pnpm). Commiti lõppu tühi rida + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: `src/lib/stripe-read.ts` — piirid, koond, Stripe lugemine

**Files:**
- Create: `src/lib/stripe-read.ts`
- Test: `src/lib/stripe-read.test.ts`

**Interfaces:**
- Produces:
  - `type Money = Record<string, number>` (valuuta → sendid)
  - `interface RevenueSummary { today: { count: number; net: Money }; thisMonth: Period; prevMonth: Period; mrr: Money; activeSubs: number; canceledThisMonth: number; recent: RecentTxn[] }`
  - `interface Period { count: number; gross: Money; net: Money }`
  - `interface RecentTxn { id: string; kind: 'payment' | 'refund' | 'dispute'; amount: number; net: number; currency: string; at: string }`
  - `tallinnBounds(now: Date): { todayStart: Date; thisMonthStart: Date; prevMonthStart: Date }`
  - `summarizeRevenue(txns: StripeTxn[], liveSubs: StripeSub[], canceledSubs: StripeSub[], now: Date): RevenueSummary`
  - `readDublyStripe(key: string, now: Date, fetchImpl?: FetchLike): Promise<RevenueSummary>`

- [ ] **Step 1: Kirjuta failivad testid** `src/lib/stripe-read.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallinnBounds, summarizeRevenue, readDublyStripe, type StripeTxn, type StripeSub } from './stripe-read';

const ts = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const txn = (id: string, cat: string, amount: number, net: number, iso: string, currency = 'eur'): StripeTxn => ({
  id, reporting_category: cat, amount, fee: amount - net, net, currency, created: ts(iso),
});
const sub = (unit: number, interval: 'day' | 'week' | 'month' | 'year', count = 1, quantity = 1, canceledIso?: string): StripeSub => ({
  status: canceledIso ? 'canceled' : 'active',
  canceled_at: canceledIso ? ts(canceledIso) : null,
  items: { data: [{ quantity, price: { unit_amount: unit, currency: 'eur', recurring: { interval, interval_count: count } } }] },
});

test('tallinnBounds uses Tallinn midnight (EEST, UTC+3 in October)', () => {
  const b = tallinnBounds(new Date('2026-10-07T12:00:00Z'));
  assert.equal(b.todayStart.toISOString(), '2026-10-06T21:00:00.000Z');
  assert.equal(b.thisMonthStart.toISOString(), '2026-09-30T21:00:00.000Z');
  assert.equal(b.prevMonthStart.toISOString(), '2026-08-31T21:00:00.000Z');
});

test('tallinnBounds handles January (previous month in previous year, EET UTC+2)', () => {
  const b = tallinnBounds(new Date('2027-01-15T10:00:00Z'));
  assert.equal(b.thisMonthStart.toISOString(), '2026-12-31T22:00:00.000Z');
  assert.equal(b.prevMonthStart.toISOString(), '2026-11-30T22:00:00.000Z');
});

test('summarize: today, this/prev month, refunds negative, non-revenue ignored', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const txns = [
    txn('t1', 'charge', 1000, 940, '2026-10-07T08:00:00Z'),
    txn('t2', 'charge', 2000, 1880, '2026-10-06T21:30:00Z'), // 00:30 7.10 Tallinn = today
    txn('t3', 'refund', -1000, -1000, '2026-10-03T10:00:00Z'),
    txn('t4', 'payout', -5000, -5000, '2026-10-02T10:00:00Z'),
    txn('t5', 'charge', 3000, 2820, '2026-09-15T10:00:00Z'),
    txn('t6', 'charge', 999, 900, '2026-08-31T20:59:00Z'), // before prev month start → ignored
  ];
  const s = summarizeRevenue(txns, [], [], now);
  assert.deepEqual(s.today, { count: 2, net: { eur: 2820 } });
  assert.deepEqual(s.thisMonth, { count: 2, gross: { eur: 2000 }, net: { eur: 1820 } });
  assert.deepEqual(s.prevMonth, { count: 1, gross: { eur: 3000 }, net: { eur: 2820 } });
  assert.deepEqual(s.recent.map((r) => [r.id, r.kind]), [['t1', 'payment'], ['t2', 'payment'], ['t3', 'refund'], ['t5', 'payment']]);
});

test('summarize keeps currencies apart', () => {
  const s = summarizeRevenue(
    [txn('a', 'charge', 1000, 900, '2026-10-05T10:00:00Z'), txn('b', 'charge', 500, 450, '2026-10-05T11:00:00Z', 'usd')],
    [], [], new Date('2026-10-07T12:00:00Z'),
  );
  assert.deepEqual(s.thisMonth.net, { eur: 900, usd: 450 });
});

test('MRR normalises intervals and quantity; counts cancellations this month only', () => {
  const live = [sub(1000, 'month'), sub(12000, 'year'), sub(500, 'week', 1, 2), sub(3000, 'month', 3)];
  const canceled = [sub(1000, 'month', 1, 1, '2026-10-02T10:00:00Z'), sub(1000, 'month', 1, 1, '2026-09-20T10:00:00Z')];
  const s = summarizeRevenue([], live, canceled, new Date('2026-10-07T12:00:00Z'));
  // 1000 + 12000/12 + 500*2*52/12 + 3000/3 = 1000 + 1000 + 4333.33 + 1000
  assert.deepEqual(s.mrr, { eur: 7333 });
  assert.equal(s.activeSubs, 4);
  assert.equal(s.canceledThisMonth, 1);
});

test('recent is capped at 10, newest first', () => {
  const txns = Array.from({ length: 12 }, (_, i) => txn(`c${i}`, 'charge', 100, 90, `2026-10-0${1 + (i % 6)}T0${i % 10}:00:00Z`));
  const s = summarizeRevenue(txns, [], [], new Date('2026-10-07T12:00:00Z'));
  assert.equal(s.recent.length, 10);
  assert.ok(s.recent.every((r, i, a) => i === 0 || a[i - 1].at >= r.at));
});

function fakeFetch(pages: Record<string, unknown[][]>) {
  const calls: string[] = [];
  const impl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer rk_test_x');
    const u = new URL(url);
    const key = u.pathname.replace('/v1', '') + (u.searchParams.get('status') ? `:${u.searchParams.get('status')}` : '');
    const list = pages[key] ?? [[]];
    // Ids are "p_<page>"; starting_after = last id of page N → serve page N + 1.
    const idx = u.searchParams.get('starting_after') ? Number(u.searchParams.get('starting_after')!.split('_').pop()) + 1 : 0;
    const data = list[idx] ?? [];
    return { ok: true, status: 200, json: async () => ({ data, has_more: idx + 1 < list.length }) };
  };
  return { impl, calls };
}

test('readDublyStripe paginates and sends created[gte] = previous month start', async () => {
  const p0 = [{ ...txn('p_0', 'charge', 100, 90, '2026-10-05T10:00:00Z') }];
  const p1 = [{ ...txn('p_1', 'charge', 200, 180, '2026-10-04T10:00:00Z') }];
  const { impl, calls } = fakeFetch({ '/balance_transactions': [p0, p1] });
  const s = await readDublyStripe('rk_test_x', new Date('2026-10-07T12:00:00Z'), impl);
  assert.equal(s.thisMonth.count, 2);
  const first = calls.find((c) => c.includes('/balance_transactions'))!;
  assert.equal(new URL(first).searchParams.get('created[gte]'), String(ts('2026-08-31T21:00:00Z')));
  assert.ok(calls.some((c) => c.includes('status=active')));
  assert.ok(calls.some((c) => c.includes('status=past_due')));
  assert.ok(calls.some((c) => c.includes('status=canceled')));
});

test('readDublyStripe refuses a full-access secret key and surfaces HTTP errors without the key', async () => {
  await assert.rejects(readDublyStripe('sk_live_abc', new Date(), fakeFetch({}).impl), /restricted/);
  const failing = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(readDublyStripe('rk_test_x', new Date(), failing), (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes('rk_test_x'));
});
```

- [ ] **Step 2: Jooksuta, kontrolli et kukub**

Run: `npx tsx --test src/lib/stripe-read.test.ts`
Expected: FAIL — `Cannot find module './stripe-read'`

- [ ] **Step 3: Kirjuta `src/lib/stripe-read.ts`**:

```ts
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
const KIND: Record<string, RecentTxn['kind']> = { charge: 'payment', refund: 'refund', dispute: 'dispute' };

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
```

- [ ] **Step 4: Jooksuta testid**

Run: `npx tsx --test src/lib/stripe-read.test.ts`
Expected: `# pass 8`, `# fail 0`. Siis `npx tsc --noEmit -p .` — uusi vigu pole.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stripe-read.ts src/lib/stripe-read.test.ts
git commit -m "jarvis: dubly Stripe revenue reader and summary (tested)"
```

---

### Task 2: `src/lib/stripe-dubly.ts` — võti, vahemälu, olek

**Files:**
- Modify: `package.json`, `package-lock.json` (`npm install server-only`)
- Create: `src/lib/stripe-dubly.ts`

**Interfaces:**
- Consumes: `readDublyStripe`, `RevenueSummary` (Task 1).
- Produces: `type DublyRevenue = { state: 'off' } | { state: 'error' } | { state: 'ok'; summary: RevenueSummary; fetchedAt: string }`; `getDublyRevenue(): Promise<DublyRevenue>`.

- [ ] **Step 1: Paigalda** `npm install server-only` (Next.js ametlik marker-pakett). Kontrolli `package.json` dependencies.

- [ ] **Step 2: Kirjuta `src/lib/stripe-dubly.ts`**:

```ts
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
    // A throw here is not cached, so a Stripe outage retries on the next request.
    const summary = await readDublyStripe(process.env.STRIPE_DUBLY_READ_KEY ?? '', now);
    return { summary, fetchedAt: now.toISOString() };
  },
  ['dubly-stripe-revenue-v1'],
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
```

- [ ] **Step 3:** `npx tsc --noEmit -p .` (puhas) ja `npm run build` (õnnestub).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/lib/stripe-dubly.ts
git commit -m "jarvis: server-only dubly Stripe revenue with 10 min cache"
```

---

### Task 3: Jarvis — TODAY-lahter, allikas, plokk „Raha · dubly.me"

**Files:**
- Modify: `src/lib/jarvis.ts`
- Modify: `src/app/(jarvis)/format.ts`
- Modify: `src/app/(jarvis)/page.tsx`

**Interfaces:**
- Consumes: `getDublyRevenue`, `DublyRevenue` (Task 2); `Money`, `RecentTxn` (Task 1).
- Produces: `JarvisData.revenue: DublyRevenue`; `fmtMoney(money: Money): string` in `format.ts`.

- [ ] **Step 1: `src/lib/jarvis.ts`.** Import: `import { getDublyRevenue, type DublyRevenue } from '@/lib/stripe-dubly';`. Lisa `JarvisData`-sse `revenue: DublyRevenue;`. Lisa `getDublyRevenue()` olemasolevasse `Promise.all`-i viimaseks ja destruktureeri `revenue`. Asenda `sources` massiivis rida `{ key: 'stripe', label: 'Stripe · dubly.me', state: 'off', ... }`:

```ts
    {
      key: 'stripe',
      label: 'Stripe · dubly.me',
      // Asked live (10 min cache): green when the last read worked, grey without a key, yellow on a Stripe error.
      state: revenue.state === 'ok' ? 'ok' : revenue.state === 'off' ? 'off' : 'stale',
      lastOkAt: revenue.state === 'ok' ? new Date(revenue.fetchedAt) : null,
      note:
        revenue.state === 'ok'
          ? `${revenue.summary.activeSubs} tellijat`
          : revenue.state === 'off'
            ? 'ühendamata (võti puudub)'
            : 'Stripe viga — vt logi',
    },
```

ja lisa `revenue` `return`-objekti.

- [ ] **Step 2: `src/app/(jarvis)/format.ts`** — lisa faili lõppu:

```ts
const moneyFmt = new Map<string, Intl.NumberFormat>();

/** "1 234,50 €" per currency, joined with " + " when there are several. Input is minor units. */
export function fmtMoney(money: Record<string, number>): string {
  const parts = Object.entries(money).map(([cur, minor]) => {
    const code = cur.toUpperCase();
    if (!moneyFmt.has(code)) moneyFmt.set(code, new Intl.NumberFormat('et-EE', { style: 'currency', currency: code }));
    return moneyFmt.get(code)!.format(minor / 100);
  });
  return parts.length ? parts.join(' + ') : '0,00 €';
}
```

- [ ] **Step 3: `src/app/(jarvis)/page.tsx` — TODAY-lahter.** Import `fmtMoney` `./format`-ist. Asenda rida
`<TodayCell label="dubly.me maksed täna" value="—" sub="Stripe ühendamata" muted className="border-l" />` sellega:

```tsx
          {d.revenue.state === 'ok' ? (
            <TodayCell
              label="dubly.me maksed täna"
              value={String(d.revenue.summary.today.count)}
              sub={`${fmtMoney(d.revenue.summary.today.net)} neto · kuu ${fmtMoney(d.revenue.summary.thisMonth.net)}`}
              className="border-l"
            />
          ) : (
            <TodayCell
              label="dubly.me maksed täna"
              value="—"
              sub={d.revenue.state === 'off' ? 'Stripe ühendamata' : 'Stripe viga'}
              tone={d.revenue.state === 'error' ? 'warn' : undefined}
              muted={d.revenue.state === 'off'}
              className="border-l"
            />
          )}
```

- [ ] **Step 4: `page.tsx` — plokk.** Lisa enne AGENT-sektsiooni (`{/* AGENT — the day track ...`) ja pärast „Ühendatud allikad" sektsiooni:

```tsx
      {/* RAHA — dubly.me revenue from Stripe (net after fees; gross in brackets) */}
      {d.revenue.state === 'ok' && (
        <section aria-labelledby="money-h" className="hq-rise mt-12">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <h2 id="money-h" className="eyebrow">Raha · dubly.me</h2>
            <p className="text-[11.5px] text-[var(--text-3)]">
              Stripe {fmtAgo(new Date(d.revenue.fetchedAt), now)} · neto pärast tasusid
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
            <Panel className="p-5 min-w-0">
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-5">
                <MoneyStat label="see kuu" value={fmtMoney(d.revenue.summary.thisMonth.net)}
                  sub={`bruto ${fmtMoney(d.revenue.summary.thisMonth.gross)} · ${d.revenue.summary.thisMonth.count} makset`} />
                <MoneyStat label="eelmine kuu" value={fmtMoney(d.revenue.summary.prevMonth.net)}
                  sub={`bruto ${fmtMoney(d.revenue.summary.prevMonth.gross)} · ${d.revenue.summary.prevMonth.count} makset`} />
                <MoneyStat label="MRR" value={fmtMoney(d.revenue.summary.mrr)} sub="ilma allahindlusteta" />
                <MoneyStat label="aktiivsed tellijad" value={String(d.revenue.summary.activeSubs)} />
                <MoneyStat label="tühistatud see kuu" value={String(d.revenue.summary.canceledThisMonth)} />
              </dl>
            </Panel>
            <Panel className="p-5">
              <Eyebrow>Viimased maksed</Eyebrow>
              {d.revenue.summary.recent.length ? (
                <ul className="mt-3 space-y-2.5">
                  {d.revenue.summary.recent.map((r) => (
                    <li key={r.id} className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`text-[13px] font-medium num ${r.net < 0 ? 'text-[var(--down)]' : 'text-[var(--text)]'}`}>
                          {fmtMoney({ [r.currency]: r.net })}
                        </p>
                        <p className="text-[11.5px] text-[var(--text-3)]">
                          {r.kind === 'payment' ? 'makse' : r.kind === 'refund' ? 'tagasimakse' : 'vaidlus'} · bruto {fmtMoney({ [r.currency]: r.amount })}
                        </p>
                      </div>
                      <span className="shrink-0 text-[11.5px] num text-[var(--text-3)]">{fmtWhen(new Date(r.at), now)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-[13px] text-[var(--text-3)]">Maksed puuduvad (eelmine ja see kuu).</p>
              )}
            </Panel>
          </div>
        </section>
      )}
```

ja faili lõppu:

```tsx
function MoneyStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="mt-1 text-[11.5px] text-[var(--text-3)]">
        {label}
        {sub && <span className="block text-[var(--text-4)]">{sub}</span>}
      </dt>
      <dd className="num text-[22px] font-semibold leading-none tracking-[-0.02em] text-[var(--text)]">{value}</dd>
    </div>
  );
}
```

- [ ] **Step 5: Kontroll** — `npx tsx --test src/lib/stripe-read.test.ts src/lib/wiki-graph.test.ts` (kõik läbivad), `npx tsc --noEmit -p .` (puhas), `npm run build` (õnnestub, `/` dünaamiline). Kohapeal DB/võtit pole — lehte ei renderda. Kontrolli `git diff --stat`, et reavahetused jäid LF.

- [ ] **Step 6: Commit**

```bash
git add src/lib/jarvis.ts "src/app/(jarvis)/format.ts" "src/app/(jarvis)/page.tsx"
git commit -m "jarvis: dubly.me revenue in TODAY, sources and Raha block"
```

---

### Task 4: Deploy, võti, kontroll prodis (kontroller + Riho)

- [ ] **Step 1:** merge `main`-i, push, oota Vercel `READY`. Ilma võtmeta: avaleht renderdub, TODAY „Stripe ühendamata", allikas hall, „Raha" plokki pole.
- [ ] **Step 2 (Riho):** Stripe → Sisum OÜ konto → Developers → API keys → **Create restricted key**: nimi „hermy-hq Jarvis (read)", õigused **Balance: Read**, **Subscriptions: Read**, kõik muu None. Vercel → hermy-hq → Settings → Environment Variables: `STRIPE_DUBLY_READ_KEY`, **Production**, **Sensitive**. Redeploy.
- [ ] **Step 3:** prodis kontroll: TODAY-lahter näitab arvu, allikas roheline, „Raha" plokk; võrdle **see kuu neto** Stripe dashboardi Balance → Transactions (sama periood, Tallinna aeg) ja **MRR** Billing → Overview-ga. Kirjuta tulemused `docs/CURRENT.md`-sse.
- [ ] **Step 4:** Docs — `docs/CURRENT.md` (etapp 4a VALMIS + kontrolli arvud), `.claude/session-handoff.md`, commit + push.
