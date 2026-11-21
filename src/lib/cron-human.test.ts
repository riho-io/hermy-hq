import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeSchedule } from './cron-human'

// Real schedules from Hermes (20.11.2026 sync).
const cases: [string, string, string][] = [
  ['every 360m', 'iga 6 h', 'valvur'],
  ['every 5m', 'iga 5 min', 'valvur'],
  ['every 180m', 'iga 3 h', 'valvur'],
  ['every 10080m', 'iga 7 päeva', 'nadal'],
  ['every monday 10:00am', 'E 10:00', 'nadal'],
  ['every monday 8:30am', 'E 08:30', 'nadal'],
  ['0 8 * * *', 'iga päev 08:00', 'paev'],
  ['30 7 * * 1-5', 'E–R 07:30', 'paev'],
  ['0 16 * * 5', 'R 16:00', 'nadal'],
  ['0 10 1 * *', '1. kuupäeval 10:00', 'kuu'],
  ['*/30 7-21 * * *', 'iga 30 min, 7–21', 'valvur'],
  ['10,40 7-21 * * *', ':10 ja :40, 7–21', 'valvur'],
  ['*/15 * * * *', 'iga 15 min', 'valvur'],
  ['*/2 * * * *', 'iga 2 min', 'valvur'],
  ['0 3 1 1 *', '1. jaanuaril 03:00', 'kuu'],
  ['15 9 * * 1', 'E 09:15', 'nadal'],
  ['0 20 * * 0', 'P 20:00', 'nadal'],
]

for (const [raw, text, group] of cases) {
  test(`${raw} -> ${text} (${group})`, () => {
    const r = describeSchedule(raw)
    assert.equal(r.text, text)
    assert.equal(r.group, group)
  })
}

test('every 1440m is "iga päev"', () => {
  assert.equal(describeSchedule('every 1440m').text, 'iga päev')
})

test('unknown shape falls back to raw string', () => {
  const r = describeSchedule('@reboot')
  assert.equal(r.text, '@reboot')
  assert.equal(r.intervalMin, null)
})

test('garbage cron fields fall back', () => {
  assert.equal(describeSchedule('0 25 * * *').text, '0 25 * * *')
  assert.equal(describeSchedule('every funday 10:00am').text, 'every funday 10:00am')
})
