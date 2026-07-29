'use strict'

const assert = require('node:assert/strict')
const { createTripDetector, createManeuverDetector, KNOT } = require('../plugin/lib/detector')

const T = 1700000000000
const at = (s) => T + s * 1000
const deg = (d) => (d * Math.PI) / 180

describe('createTripDetector', function () {
  it('starts only after movement is sustained, timestamped at its onset', function () {
    const d = createTripDetector({ startKnots: 0.5, startMinSeconds: 180 })
    let started = null
    d.feed(at(0), 0.1 * KNOT, (t) => { started = t }) // still
    d.feed(at(10), 2 * KNOT, (t) => { started = t }) // moving, onset
    d.feed(at(100), 2 * KNOT, (t) => { started = t }) // not long enough
    assert.equal(started, null)
    d.feed(at(200), 2 * KNOT, (t) => { started = t }) // > 180 s later
    assert.equal(started, at(10), 'start time is when movement began')
  })

  it('ignores a brief speed spike', function () {
    const d = createTripDetector({ startKnots: 0.5, startMinSeconds: 180 })
    let started = false
    d.feed(at(0), 2 * KNOT, () => { started = true })
    d.feed(at(30), 0.1 * KNOT, () => { started = true }) // spike over before startMin
    d.feed(at(400), 0.1 * KNOT, () => { started = true })
    assert.equal(started, false)
  })

  it('rejects NaN timestamps and values', function () {
    const d = createTripDetector({})
    let fired = false
    d.feed(NaN, 5, () => { fired = true })
    d.feed(at(0), NaN, () => { fired = true })
    assert.equal(fired, false)
  })
})

describe('createManeuverDetector', function () {
  function runFlip (opts, entryDeg, holdSeconds) {
    const d = createManeuverDetector(opts)
    const events = []
    const cb = (m) => events.push(m)
    d.feed(at(0), deg(entryDeg), 5, cb) // starboard
    d.feed(at(5), deg(entryDeg), 5, cb)
    for (let s = 10; s <= 10 + holdSeconds + 5; s += 5) {
      d.feed(at(s), deg(-entryDeg), 5, cb) // port
    }
    return events
  }

  it('classifies a bow crossing as a tack', function () {
    const events = runFlip({ minTackSeconds: 90 }, 45, 90)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'tack')
  })

  it('classifies a stern crossing as a gybe', function () {
    const events = runFlip({ minTackSeconds: 90 }, 140, 90)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'gybe')
  })

  it('does not count a flip held for less than the minimum', function () {
    const events = runFlip({ minTackSeconds: 90 }, 45, 30)
    assert.equal(events.length, 0)
  })

  it('suppresses a maneuver below the speed gate', function () {
    const d = createManeuverDetector({ minTackSeconds: 90, minSpeed: 2 })
    const events = []
    const cb = (m) => events.push(m)
    d.feed(at(0), deg(45), 0.5, cb) // slow (under engine)
    for (let s = 10; s <= 110; s += 5) {
      d.feed(at(s), deg(-45), 0.5, cb)
    }
    assert.equal(events.length, 0)
  })

  it('gates on the median speed, not on a single slow sample', function () {
    const d = createManeuverDetector({ minTackSeconds: 90, minSpeed: 2 })
    const events = []
    const cb = (m) => events.push(m)
    // A paddle wheel alternating between the true speed and half of it, with the
    // sample just before the flip landing on a low reading.
    for (let s = 0; s <= 5; s += 1) {
      d.feed(at(s), deg(45), s === 5 ? 0.5 : 4, cb)
    }
    for (let s = 10; s <= 110; s += 5) {
      d.feed(at(s), deg(-45), 4, cb)
    }
    assert.equal(events.length, 1)
  })

  it('ignores wind-angle flutter that never moves the running mean across', function () {
    const d = createManeuverDetector({ minTackSeconds: 45, minSpeed: 0 })
    const events = []
    const cb = (m) => events.push(m)
    // A masthead unit swinging ±70° about a mean of 60° to starboard: every other
    // sample reads on the port side, but the boat never changes tack.
    for (let s = 0; s <= 600; s += 1) {
      d.feed(at(s), deg(s % 2 ? -10 : 130), 4, cb)
    }
    assert.equal(events.length, 0)
  })

  it('still sees a real tack through that flutter', function () {
    const d = createManeuverDetector({ minTackSeconds: 45, minSpeed: 0 })
    const events = []
    const cb = (m) => events.push(m)
    for (let s = 0; s <= 300; s += 1) {
      d.feed(at(s), deg(s % 2 ? -10 : 130), 4, cb) // mean 60° starboard
    }
    for (let s = 301; s <= 600; s += 1) {
      d.feed(at(s), deg(s % 2 ? 10 : -130), 4, cb) // mean 60° port
    }
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'tack')
  })

  it('reads raw samples when smoothing is switched off', function () {
    const d = createManeuverDetector({ minTackSeconds: 45, minSpeed: 0, smoothSeconds: 0 })
    const events = []
    const cb = (m) => events.push(m)
    for (let s = 0; s <= 600; s += 1) {
      d.feed(at(s), deg(s % 2 ? -10 : 130), 4, cb)
    }
    assert.ok(events.length > 0, 'unsmoothed flutter registers as maneuvers')
  })
})
