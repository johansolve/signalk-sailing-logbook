'use strict'

const assert = require('node:assert/strict')
const { createTripDetector, createManeuverDetector, createSpeedGate, KNOT } = require('../plugin/lib/detector')

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

describe('createTripDetector position rules', function () {
  const M = 1 / 111320 // one metre of latitude, in degrees
  const LAT = 57.75
  const LON = 11.7

  // Where the boat is at second s. A boat lying to a mooring wanders inside a
  // circle (GPS noise plus the swing itself); one under way tracks north.
  const moored = (radiusM, fromM) => (s) => {
    const a = (s / 15) * 1.7 // no RNG: a fixed irrational-ish step round the circle
    return [LAT + (Math.sin(a) * radiusM + (fromM || 0)) * M, LON + Math.cos(a) * radiusM * M]
  }
  const making = (knots, fromM) => (s) => [LAT + ((fromM || 0) + s * knots * KNOT) * M, LON]
  const frozen = (fromM) => () => [LAT + (fromM || 0) * M, LON]

  // Replay a stretch the way both real paths do: position fixes arriving between
  // the speed samples, not all of them up front. Live feeds fixes every 5 s and
  // a speed bucket every 30 s; the retro scan, 15 s and 30 s. Returns the events.
  function replay (d, from, seconds, knots, place, events, fixSeconds) {
    const step = fixSeconds || 15
    for (let s = from; s <= from + seconds; s += step) {
      if (place) {
        const [lat, lon] = place(s)
        d.feedPosition(at(s), lat, lon)
      }
      if (s % 30 === 0) {
        d.feed(at(s), knots * KNOT,
          (t) => events.push(['start', t / 1000 - T / 1000]),
          (t) => events.push(['stop', t / 1000 - T / 1000]))
      }
    }
    return events
  }

  it('ends a trip that stays inside the circle, whatever the speed says', function () {
    // The 2026-08-02 case: 0.4 kn of GPS noise at a buoy, forever.
    const d = createTripDetector({ initialMoving: true, stopSpreadMeters: 50 })
    const events = replay(d, 0, 600, 0.4, moored(6), [])
    assert.deepEqual(events, [['stop', 0]], 'backdated to the start of the stop window')
  })

  it('leaves a moving boat alone even when it is slow', function () {
    // 0.5 kn covers 154 m in ten minutes, which is nowhere near confined.
    const d = createTripDetector({ initialMoving: true, stopSpreadMeters: 50 })
    assert.deepEqual(replay(d, 0, 900, 0.5, making(0.5), []), [])
  })

  it('does not read a frozen GPS as a boat at rest', function () {
    // The same coordinate, over and over, while the log reports 5 kn: the fix has
    // stopped, not the boat.
    const d = createTripDetector({ initialMoving: true, stopSpreadMeters: 50 })
    assert.deepEqual(replay(d, 0, 1200, 5, frozen(), []), [])
  })

  it('does not end a trip held in front of a bridge', function () {
    // Working back and forth in a 30 m box at 1.2 kn waiting for an opening: the
    // boat is confined but plainly under way, and the passage is not over.
    const d = createTripDetector({ initialMoving: true, stopSpreadMeters: 50 })
    assert.deepEqual(replay(d, 0, 1200, 1.2, moored(15), []), [])
  })

  it('abstains when the trail has a hole in it', function () {
    const d = createTripDetector({ initialMoving: true, stopSpreadMeters: 50 })
    const events = []
    replay(d, 0, 200, 0.4, moored(6), events)
    replay(d, 215, 85, 0.4, null, events) // five minutes with no fixes at all
    replay(d, 500, 100, 0.4, moored(6), events)
    assert.deepEqual(events, [], 'lost position must not end a trip')
  })

  it('abstains when there are no fixes at all', function () {
    const d = createTripDetector({ initialMoving: true, stopSpreadMeters: 50 })
    assert.deepEqual(replay(d, 0, 900, 0.4, null, []), [])
  })

  it('still ends a trip on the speed rule alone', function () {
    // No position data, speed under the stop threshold for the full window.
    const d = createTripDetector({ initialMoving: true, stopSpreadMeters: 50 })
    assert.deepEqual(replay(d, 0, 660, 0.1, null, []), [['stop', 0]])
  })

  it('holds a trip back until the boat has actually left', function () {
    // A gust at the buoy: reported speed over the start threshold for three
    // quarters of an hour, boat exactly where it was. The old rule started a
    // trip every time the candidate window outgrew the trail.
    const d = createTripDetector({ stopSpreadMeters: 50 })
    const events = replay(d, 0, 2700, 0.6, moored(6), [])
    assert.deepEqual(events, [], 'swinging round a buoy is not a departure')
  })

  it('starts once she leaves, and does not close it again on the way out', function () {
    // Leaving at exactly the start threshold: three minutes covers 46 m, so the
    // stop window still holds the mooring and everything since. The stop rule
    // must not fire inside a trip younger than that window.
    const d = createTripDetector({ stopSpreadMeters: 50 })
    const events = replay(d, 0, 600, 0.2, moored(5), [])
    replay(d, 615, 1800, 0.5, (s) => making(0.5, 0)(s - 615), events)
    assert.deepEqual(events, [['start', 630]])
  })

  it('starts on speed alone when there is no position to check', function () {
    const d = createTripDetector({ stopSpreadMeters: 50 })
    assert.deepEqual(replay(d, 0, 200, 2, null, []), [['start', 0]])
  })

  it('switches both rules off at zero', function () {
    const d = createTripDetector({ initialMoving: true, stopSpreadMeters: 0 })
    assert.deepEqual(replay(d, 0, 900, 0.4, moored(6), []), [])
  })

  it('drops the trail when time jumps backwards', function () {
    // A replayed scan lands inside the window the old fixes occupied. Kept in
    // place they would fill it with a second, unordered series and the gap check
    // would read it as covered.
    const d = createTripDetector({ initialMoving: true, stopSpreadMeters: 50 })
    const events = []
    replay(d, 0, 900, 0.4, moored(6), events) // ends with a stop, as it should
    const d2 = createTripDetector({ initialMoving: true, stopSpreadMeters: 50 })
    replay(d2, 300, 600, 0.4, moored(6), [])
    const after = []
    replay(d2, 0, 200, 0.4, moored(6), after) // an earlier window, replayed
    assert.deepEqual(after, [], 'the older fixes must not stand in for a full window')
  })

  it('sees the live cadence the same way as the retro one', function () {
    // Live feeds fixes every 5 s against the scan's 15 s, and the same stretch
    // must reach the same verdict either way.
    const live = createTripDetector({ initialMoving: true, stopSpreadMeters: 50 })
    const retro = createTripDetector({ initialMoving: true, stopSpreadMeters: 50 })
    assert.deepEqual(
      replay(live, 0, 600, 0.4, moored(6), [], 5),
      replay(retro, 0, 600, 0.4, moored(6), [], 15)
    )
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

describe('createSpeedGate (fouled log fallback)', function () {
  const kn = (v) => v * KNOT
  // Feed a run of samples one second apart and collect what the gate returned.
  const run = (gate, from, seconds, stw, sog) => {
    const out = []
    for (let s = 0; s < seconds; s++) {
      out.push(gate.speedAt(at(from + s), stw, sog))
    }
    return out
  }

  it('uses the log while it reads anything at all', function () {
    const g = createSpeedGate()
    assert.deepEqual(run(g, 0, 120, kn(5.5), kn(6)), new Array(120).fill(kn(5.5)))
  })

  it('keeps the log when a current holds it below the ground track', function () {
    // 2 kn of current under a boat making 6 over the ground is real, not a foul,
    // and an implausibly low reading is still a reading.
    const g = createSpeedGate()
    assert.equal(g.speedAt(at(0), kn(4), kn(6)), kn(4))
    assert.equal(g.speedAt(at(1), kn(0.3), kn(6)), kn(0.3))
  })

  it('rides out a brief zero without switching source', function () {
    // A dropped sample or a wheel stalling in a lull: 29 s of zero, still the log.
    const g = createSpeedGate()
    assert.deepEqual(run(g, 0, 29, 0, kn(6)), new Array(29).fill(0))
  })

  it('falls back to SOG once the zero has held for the full run', function () {
    // The 2026-08-01 case: weed on the wheel, 6 kn over the ground, and every
    // maneuver of the day dropped by a 2 kn gate.
    const g = createSpeedGate()
    run(g, 0, 30, 0, kn(6))
    assert.equal(g.speedAt(at(30), 0, kn(6)), kn(6))
    assert.equal(g.speedAt(at(600), 0, kn(6)), kn(6))
  })

  it('hands back to the log on its first positive reading', function () {
    const g = createSpeedGate()
    run(g, 0, 60, 0, kn(6))
    assert.equal(g.speedAt(at(61), kn(5.6), kn(6)), kn(5.6))
    // And a later zero has to earn the fallback all over again.
    assert.equal(g.speedAt(at(62), 0, kn(6)), 0)
  })

  it('treats a missing log the same as a zero one', function () {
    const g = createSpeedGate()
    assert.equal(g.speedAt(at(0), null, kn(6)), null)
    assert.equal(g.speedAt(at(30), null, kn(6)), kn(6))
  })

  it('returns the log untouched when there is no ground track to compare', function () {
    const g = createSpeedGate()
    run(g, 0, 60, 0, null)
    assert.equal(g.speedAt(at(60), 0, null), 0)
    assert.equal(g.speedAt(at(61), null, null), null)
  })

  it('starts a fresh run when time jumps backwards', function () {
    // A restart, or a scan replayed over an earlier window.
    const g = createSpeedGate()
    run(g, 1000, 60, 0, kn(6))
    assert.equal(g.speedAt(at(0), 0, kn(6)), 0)
  })
})
