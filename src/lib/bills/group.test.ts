import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignGroup } from './group'

const groups = [
  { id: 'suvila', keywords: ['Metsa tee 3', 'K-777'], sortOrder: 2 },
  { id: 'kodu', keywords: ['Näidise 5', 'K-100'], sortOrder: 1 },
]

test('matches keyword case-insensitively across all parts', () => {
  assert.equal(assignGroup(['Elektriarve', 'NÄIDISE 5, Jõhvi'], groups), 'kodu')
  assert.equal(assignGroup([null, 'leping k-777'], groups), 'suvila')
})
test('lowest sortOrder wins when several groups match', () => {
  assert.equal(assignGroup(['Näidise 5 ja Metsa tee 3'], groups), 'kodu')
})
test('no match gives null (Sorteerimata)', () => {
  assert.equal(assignGroup(['Tundmatu 9'], groups), null)
})
test('empty or too short keywords never match everything', () => {
  assert.equal(assignGroup(['mis tahes'], [{ id: 'x', keywords: ['', ' ', 'ab'], sortOrder: 0 }]), null)
})
