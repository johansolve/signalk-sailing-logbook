'use strict'

const assert = require('node:assert/strict')
const { fromStateSeries } = require('../plugin/lib/engine')

const T = 1700000000000
const h = 3600000

describe('fromStateSeries', function () {
  it('returns null for empty or single-point series', function () {
    assert.equal(fromStateSeries([]), null)
    assert.equal(fromStateSeries([[T, 'started']]), null)
    assert.equal(fromStateSeries(null), null)
  })

  it('computes the on-fraction as a time integral', function () {
    // started for the first half, stopped for the second
    const r = fromStateSeries([[T, 'started'], [T + h / 2, 'stopped'], [T + h, 'stopped']])
    assert.equal(r.share, 0.5)
  })

  it('onAt is a left-continuous step function', function () {
    const r = fromStateSeries([[T, 'stopped'], [T + h / 2, 'started'], [T + h, 'started']])
    assert.equal(r.onAt(T + h / 4), false) // before the change
    assert.equal(r.onAt(T + (3 * h) / 4), true) // after the change
    assert.equal(r.onAt(T), false) // exactly at the first point
  })

  it('treats only "started" as on', function () {
    const r = fromStateSeries([[T, 'stopped'], [T + h, 'unusable']])
    assert.equal(r.share, 0)
    assert.equal(r.onAt(T + h / 2), false)
  })

  it('fraction integrates on-time over a sub-window', function () {
    // started [T, T+2h), stopped [T+2h, T+3h]
    const r = fromStateSeries([[T, 'started'], [T + 2 * h, 'stopped'], [T + 3 * h, 'stopped']])
    assert.equal(r.fraction(T, T + h), 1) // first hour fully under engine
    assert.equal(r.fraction(T + 2 * h, T + 3 * h), 0) // last hour off
    assert.equal(r.fraction(T + 1.5 * h, T + 2.5 * h), 0.5) // straddles the transition
    assert.equal(r.fraction(T + h, T + h), null) // non-positive window
  })
})
