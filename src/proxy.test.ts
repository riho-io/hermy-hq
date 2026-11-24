import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { proxy } from './proxy';

const GOOD_SECRET = 'a'.repeat(64);
process.env.NEXTAUTH_SECRET = 'test-nextauth-secret-for-proxy-tests-only';

function req(path: string, opts: { method?: string; secret?: string; cookie?: string } = {}) {
  const headers = new Headers();
  if (opts.secret !== undefined) headers.set('x-internal-secret', opts.secret);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  return new NextRequest(`http://localhost${path}`, { method: opts.method ?? 'GET', headers });
}

// NextResponse.next() carries this header; a 401 or redirect does not.
const passed = (res: Response) => res.headers.get('x-middleware-next') === '1';

process.env.ALLOWED_EMAILS = 'riho@example.com';
process.env.BILLS_GUEST_EMAILS = 'guest@example.com';

async function sessionCookie(email = 'riho@example.com') {
  const token = await encode({ token: { email }, secret: process.env.NEXTAUTH_SECRET! });
  return `next-auth.session-token=${token}`;
}

test('correct header on GET /api/reminders passes', async () => {
  process.env.INTERNAL_API_SECRET = GOOD_SECRET;
  assert.ok(passed(await proxy(req('/api/reminders', { secret: GOOD_SECRET }))));
});

test('wrong or missing header on /api/reminders is 401', async () => {
  process.env.INTERNAL_API_SECRET = GOOD_SECRET;
  assert.equal((await proxy(req('/api/reminders', { secret: 'b'.repeat(64) }))).status, 401);
  assert.equal((await proxy(req('/api/reminders'))).status, 401);
});

test('placeholder secret is rejected even when the header matches it', async () => {
  process.env.INTERNAL_API_SECRET = 'your-internal-api-secret';
  assert.equal((await proxy(req('/api/reminders', { secret: 'your-internal-api-secret' }))).status, 401);
});

test('short secret (< 32 chars) is rejected even when the header matches it', async () => {
  process.env.INTERNAL_API_SECRET = 'x'.repeat(31);
  assert.equal((await proxy(req('/api/reminders', { secret: 'x'.repeat(31) }))).status, 401);
});

test('empty secret never matches an empty header', async () => {
  process.env.INTERNAL_API_SECRET = '';
  assert.equal((await proxy(req('/api/reminders', { secret: '' }))).status, 401);
});

test('correct header does not open other methods, other APIs or pages', async () => {
  process.env.INTERNAL_API_SECRET = GOOD_SECRET;
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    assert.equal((await proxy(req('/api/reminders', { method, secret: GOOD_SECRET }))).status, 401, method);
  }
  for (const path of ['/api/x-content', '/api/cache/clear', '/api/youtube/ideas', '/api/trends/snipe', '/api/reminders/x']) {
    assert.equal((await proxy(req(path, { method: 'POST', secret: GOOD_SECRET }))).status, 401, path);
  }
  const page = await proxy(req('/', { secret: GOOD_SECRET }));
  assert.equal(page.status, 307);
  assert.match(page.headers.get('location') ?? '', /\/login$/);
});

test('logged-in user still reaches pages and APIs without the header', async () => {
  process.env.INTERNAL_API_SECRET = GOOD_SECRET;
  const cookie = await sessionCookie();
  assert.ok(passed(await proxy(req('/', { cookie }))));
  assert.ok(passed(await proxy(req('/api/reminders', { method: 'POST', cookie }))));
  assert.ok(passed(await proxy(req('/api/cache/clear', { method: 'POST', cookie }))));
});

test('bills: ingest POST passes (route checks the secret), old Resend door is gone; bills-due GET passes; other ingest GET stays 401', async () => {
  assert.ok(passed(await proxy(req('/api/ingest/bills', { method: 'POST' }))));
  assert.equal((await proxy(req('/api/ingest/bills'))).status, 401);
  assert.equal((await proxy(req('/api/inbound/resend', { method: 'POST' }))).status, 401);
  assert.ok(passed(await proxy(req('/api/ingest/bills-due'))));
  assert.equal((await proxy(req('/api/ingest/argo-health'))).status, 401);
});

test('bills API needs a session', async () => {
  assert.equal((await proxy(req('/api/bills'))).status, 401);
  assert.equal((await proxy(req('/api/bill-groups'))).status, 401);
  assert.equal((await proxy(req('/api/bills/file?id=x'))).status, 401);
});

test('bill guest reaches only /arved, GET+PATCH /api/bills and GET /api/bills/file', async () => {
  const cookie = await sessionCookie('Guest@Example.com');
  assert.ok(passed(await proxy(req('/arved', { cookie }))));
  assert.ok(passed(await proxy(req('/api/bills', { cookie }))));
  assert.ok(passed(await proxy(req('/api/bills', { method: 'PATCH', cookie }))));
  assert.ok(passed(await proxy(req('/api/bills/file?id=x', { cookie }))));
  for (const method of ['POST', 'DELETE']) {
    assert.equal((await proxy(req('/api/bills', { method, cookie }))).status, 403, method);
  }
  for (const path of ['/api/bill-groups', '/api/reminders', '/api/hermes/crons', '/api/x-content', '/api/cache/clear']) {
    assert.equal((await proxy(req(path, { method: 'POST', cookie }))).status, 403, path);
  }
  for (const path of ['/', '/cronid', '/konto', '/arved/x']) {
    const page = await proxy(req(path, { cookie }));
    assert.equal(page.status, 307, path);
    assert.match(page.headers.get('location') ?? '', /\/arved$/);
  }
});

test('session of an address no longer on any list is refused at once', async () => {
  const cookie = await sessionCookie('removed@example.com');
  assert.equal((await proxy(req('/api/bills', { cookie }))).status, 403);
  const page = await proxy(req('/arved', { cookie }));
  assert.equal(page.status, 307);
  assert.match(page.headers.get('location') ?? '', /\/login$/);
});
