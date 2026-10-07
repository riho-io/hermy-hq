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
