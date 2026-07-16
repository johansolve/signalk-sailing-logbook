'use strict'

const assert = require('node:assert/strict')
const { buildReport } = require('../plugin/lib/report')

const T = Date.parse('2026-07-14T09:00:00Z')
const trip = {
  start_time: T,
  stop_time: T + 3600000,
  distance_nm: 5.2,
  max_stw: 3.4,
  start_place: 'Alpha',
  stop_place: 'Beta',
  engine_share: 0
}
const events = [{ time: T + 600000, type: 'gybe', twa_before: 2.4, twa_after: -2.3 }]

describe('buildReport', function () {
  it('a sailing trip names maneuvers', function () {
    const out = buildReport(trip, events, [], 'en', false)
    assert.match(out, /Passage/)
    assert.match(out, /gybe/i)
  })

  it('a motoring trip omits maneuvers', function () {
    const out = buildReport(trip, events, [], 'en', true)
    assert.match(out, /Motoring/)
    assert.doesNotMatch(out, /gybe/i)
  })

  it('the Swedish header uses Segling / Motortur', function () {
    assert.match(buildReport(trip, events, [], 'sv', false), /Segling/)
    assert.match(buildReport(trip, events, [], 'sv', true), /Motortur/)
  })

  it('omits hourly fields that have no data (no dash noise)', function () {
    const hourly = [{ time: T, tws: { mean: 5, p10: 4, p90: 6 }, stw: {}, twd: {}, twa: {}, awa: {}, heel: {} }]
    const line = buildReport(trip, [], hourly, 'sv', false).split('\n').find((l) => /^\d\d:/.test(l))
    assert.match(line, /TWS/)
    assert.doesNotMatch(line, /–/)
  })

  it('renders TWD without a spread when it is undefined', function () {
    const hourly = [{ time: T, tws: { mean: 5, p10: 4, p90: 6 }, stw: {}, twd: { mean: Math.PI, std: null }, twa: {}, awa: {}, heel: {} }]
    const line = buildReport(trip, [], hourly, 'sv', false).split('\n').find((l) => /^\d\d:/.test(l))
    assert.match(line, /TWD/)
    assert.doesNotMatch(line, /±/)
  })

  it('a motoring hour shows a Motor badge instead of TWA/AWA', function () {
    const hourly = [{
      time: T, motor: true,
      tws: { mean: 5, p10: 4, p90: 6 }, stw: {}, twd: {},
      twa: { mean: 0.8, p10: 0.7, p90: 0.9, side: 1 },
      awa: { mean: 0.7, p10: 0.6, p90: 0.8, side: 1 }, heel: {}
    }]
    const line = buildReport(trip, [], hourly, 'en', false).split('\n').find((l) => /^\d\d:/.test(l))
    assert.match(line, /Motor/)
    assert.doesNotMatch(line, /TWA/)
    assert.doesNotMatch(line, /AWA/)
  })

  it('reports motoring time and percent when the engine ran', function () {
    const mixed = Object.assign({}, trip, { engine_share: 0.25 })
    const out = buildReport(mixed, [], [], 'en', false)
    assert.match(out, /engine/)
    assert.match(out, /25%/)
    // a zero-engine trip says nothing about motoring
    assert.doesNotMatch(buildReport(trip, [], [], 'en', false), /engine \d/)
  })
})
