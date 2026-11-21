import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedPdfUrl } from './pdf-url'

test('allows https resend.com and its subdomains', () => {
  assert.equal(isAllowedPdfUrl('https://resend.com/x.pdf'), true)
  assert.equal(isAllowedPdfUrl('https://inbound-cdn.resend.com/a/b?sig=1'), true)
})
test('rejects lookalike and suffix hosts', () => {
  assert.equal(isAllowedPdfUrl('https://evilresend.com/x'), false)
  assert.equal(isAllowedPdfUrl('https://resend.com.evil.tld/x'), false)
})
test('rejects userinfo trick', () => {
  assert.equal(isAllowedPdfUrl('https://resend.com@evil.tld/x'), false)
})
test('rejects non-https', () => {
  assert.equal(isAllowedPdfUrl('http://resend.com/x'), false)
  assert.equal(isAllowedPdfUrl('ftp://resend.com/x'), false)
})
test('rejects trailing-dot hosts', () => {
  assert.equal(isAllowedPdfUrl('https://resend.com./x'), false)
  assert.equal(isAllowedPdfUrl('https://cdn.resend.com./x'), false)
})
test('rejects malformed URLs', () => {
  assert.equal(isAllowedPdfUrl('not a url'), false)
  assert.equal(isAllowedPdfUrl(''), false)
  assert.equal(isAllowedPdfUrl('https://'), false)
})
