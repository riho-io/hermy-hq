import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tallinnToday, daysBetween, dueNotices } from './notices'

const b = (over: Partial<Parameters<typeof dueNotices>[0][number]> = {}) => ({
  id: 'b1', status: 'new', dueDate: '2026-12-05', remind3SentAt: null, remindDueSentAt: null, ...over,
})

test('tallinnToday uses Tallinn date, not UTC', () => {
  assert.equal(tallinnToday(new Date('2026-11-21T22:30:00Z')), '2026-11-22') // 00:30 Tallinn
  assert.equal(tallinnToday(new Date('2026-11-21T10:00:00Z')), '2026-11-21')
})
test('tallinnToday in summer (EEST, UTC+3)', () => {
  assert.equal(tallinnToday(new Date('2026-07-01T21:30:00Z')), '2026-07-02')
})
test('1 day before: d3 with daysLeft 1', () => {
  assert.deepEqual(dueNotices([b()], '2026-12-04'), [{ id: 'b1', kind: 'd3', daysLeft: 1 }])
})
test('remind3SentAt set but due today still gives due', () => {
  assert.deepEqual(dueNotices([b({ remind3SentAt: new Date() })], '2026-12-05'), [{ id: 'b1', kind: 'due', daysLeft: 0 }])
})
test('daysBetween counts whole days', () => {
  assert.equal(daysBetween('2026-12-02', '2026-12-05'), 3)
  assert.equal(daysBetween('2026-12-05', '2026-12-05'), 0)
  assert.equal(daysBetween('2026-12-06', '2026-12-05'), -1)
})
test('4 days before: nothing; 3 days before: d3', () => {
  assert.deepEqual(dueNotices([b()], '2026-12-01'), [])
  assert.deepEqual(dueNotices([b()], '2026-12-02'), [{ id: 'b1', kind: 'd3', daysLeft: 3 }])
})
test('d3 is sent once', () => {
  assert.deepEqual(dueNotices([b({ remind3SentAt: new Date() })], '2026-12-03'), [])
})
test('due day gives due, once', () => {
  assert.deepEqual(dueNotices([b()], '2026-12-05'), [{ id: 'b1', kind: 'due', daysLeft: 0 }])
  assert.deepEqual(dueNotices([b({ remindDueSentAt: new Date() })], '2026-12-05'), [])
})
test('overdue bill never notified before gets one due notice, then silence', () => {
  assert.deepEqual(dueNotices([b()], '2026-12-09'), [{ id: 'b1', kind: 'due', daysLeft: -4 }])
  assert.deepEqual(dueNotices([b({ remindDueSentAt: new Date() })], '2026-12-09'), [])
})
test('paid, ignored and undated bills are never notified', () => {
  assert.deepEqual(dueNotices([b({ status: 'paid' })], '2026-12-05'), [])
  assert.deepEqual(dueNotices([b({ status: 'ignored' })], '2026-12-05'), [])
  assert.deepEqual(dueNotices([b({ dueDate: null })], '2026-12-05'), [])
})
test('review bills with a due date are notified too', () => {
  assert.equal(dueNotices([b({ status: 'review' })], '2026-12-05').length, 1)
})
