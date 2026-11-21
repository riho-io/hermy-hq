import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ManualBillSchema, BillPatchSchema, GroupSchema, GroupPatchSchema, eurosToCents, patchToData, dropUnchanged } from './validate'

test('manual bill: minimal valid input', () => {
  const r = ManualBillSchema.safeParse({ supplier: 'Elektrimüüja', amount: 12.5, dueDate: '2026-12-05' })
  assert.equal(r.success, true)
})
test('manual bill: supplier required, bad date and negative amount rejected, unknown keys rejected', () => {
  assert.equal(ManualBillSchema.safeParse({ supplier: '' }).success, false)
  assert.equal(ManualBillSchema.safeParse({ supplier: 'X', dueDate: '2026-02-31' }).success, false)
  assert.equal(ManualBillSchema.safeParse({ supplier: 'X', amount: -3 }).success, false)
  assert.equal(ManualBillSchema.safeParse({ supplier: 'X', status: 'paid', remindDueSentAt: 'x' }).success, false)
})
test('eurosToCents', () => {
  assert.equal(eurosToCents(12.5), 1250)
  assert.equal(eurosToCents(null), null)
})
test('patch: marking paid sets paidAt, un-paying clears it', () => {
  const now = new Date('2026-12-01T10:00:00Z')
  assert.deepEqual(patchToData({ id: 'x', status: 'paid' }, now), { status: 'paid', paidAt: now })
  assert.deepEqual(patchToData({ id: 'x', status: 'new' }, now), { status: 'new', paidAt: null })
})
test('patch: changing the due date re-arms both reminders', () => {
  const d = patchToData({ id: 'x', dueDate: '2026-12-20' })
  assert.equal(d.remind3SentAt, null)
  assert.equal(d.remindDueSentAt, null)
  assert.ok(d.dueDate instanceof Date)
})
test('patch: untouched fields stay absent from the update', () => {
  assert.deepEqual(patchToData({ id: 'x', notes: 'tere' }), { notes: 'tere' })
})
test('patch: amount in euros becomes cents', () => {
  assert.equal(patchToData({ id: 'x', amount: 45.2 }).amountCents, 4520)
})
test('group patch: omitted keywords stay absent (must not wipe stored keywords)', () => {
  const p = GroupPatchSchema.parse({ id: 'x', name: 'Uus' })
  assert.equal('keywords' in p, false)
})
test('group: keywords default to []', () => {
  assert.deepEqual(GroupSchema.parse({ name: 'Kodu' }).keywords, [])
})
test('patch: status new clears paidAt', () => {
  assert.equal(patchToData({ id: 'x', status: 'new' }).paidAt, null)
})
test('patch: dueDate null clears the date and re-arms both reminders', () => {
  const d = patchToData({ id: 'x', dueDate: null })
  assert.equal(d.dueDate, null)
  assert.equal(d.remind3SentAt, null)
  assert.equal(d.remindDueSentAt, null)
})
test('group: keywords shorter than 3 chars or too many are rejected', () => {
  assert.equal(GroupSchema.safeParse({ name: 'Kodu', keywords: ['ab'] }).success, false)
  assert.equal(GroupSchema.safeParse({ name: 'Kodu', keywords: Array(21).fill('abcd') }).success, false)
  assert.equal(GroupSchema.safeParse({ name: 'Kodu', address: 'Näidise 5', keywords: ['Näidise 5'] }).success, true)
})
test('dropUnchanged: same dueDate and same status are removed (no re-arm, paidAt kept)', () => {
  const existing = { dueDate: '2026-12-05', status: 'paid' }
  const p = dropUnchanged({ id: 'x', dueDate: '2026-12-05', status: 'paid', notes: 'a' }, existing)
  assert.deepEqual(p, { id: 'x', notes: 'a' })
  assert.deepEqual(patchToData(p), { notes: 'a' })
})
test('dropUnchanged: changed values and null stay', () => {
  assert.deepEqual(dropUnchanged({ id: 'x', dueDate: '2026-12-06', status: 'paid' }, { dueDate: '2026-12-05', status: 'new' }), {
    id: 'x', dueDate: '2026-12-06', status: 'paid',
  })
  assert.deepEqual(dropUnchanged({ id: 'x', dueDate: null }, { dueDate: '2026-12-05', status: 'new' }), { id: 'x', dueDate: null })
})
test('dropUnchanged: clearing an already empty dueDate is a no-op', () => {
  assert.deepEqual(dropUnchanged({ id: 'x', dueDate: null }, { dueDate: null, status: 'new' }), { id: 'x' })
})
