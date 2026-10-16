import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, htmlToText, isBlockedAddress, type LookupFn } from './public-url';

// No network in tests: a fake resolver with one public and one private name.
const fakeLookup: LookupFn = async (host) => {
  if (host === 'example.com') return [{ address: '93.184.215.14', family: 4 }];
  if (host === 'internal.example') return [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }];
  if (host === 'localhost') return [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
  throw new Error('ENOTFOUND');
};

const rejects = (raw: unknown) => assert.rejects(assertPublicUrl(raw, fakeLookup), Error, String(raw));

test('accepts a public https and http url', async () => {
  assert.equal((await assertPublicUrl('https://example.com/a?b=1', fakeLookup)).hostname, 'example.com');
  assert.equal((await assertPublicUrl('http://example.com:80/', fakeLookup)).hostname, 'example.com');
});

test('rejects shell-style strings and non-strings', async () => {
  for (const raw of ['$(id)', '`id`', '"; id; "', 'https://x" ; id ; "', 'example.com', '', null, 42, {}]) {
    await rejects(raw);
  }
});

test('rejects non-http schemes', async () => {
  for (const raw of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'javascript:alert(1)', 'data:text/html,x']) {
    await rejects(raw);
  }
});

test('rejects loopback, private, link-local and metadata addresses', async () => {
  for (const raw of [
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://localhost/',
  ]) {
    await rejects(raw);
  }
});

test('rejects a name when any resolved address is private', async () => {
  await rejects('https://internal.example/');
});

test('rejects unresolvable names, odd ports and credentials', async () => {
  await rejects('https://nope.invalid/');
  await rejects('http://example.com:8080/');
  await rejects('https://user:pw@example.com/');
});

test('isBlockedAddress treats garbage as blocked', () => {
  assert.equal(isBlockedAddress('not-an-ip'), true);
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
});

test('htmlToText drops scripts, styles and tags', () => {
  assert.equal(htmlToText('<p>a</p><script>x()</script><style>.b{}</style>\n<b>c</b>'), 'a c');
});
