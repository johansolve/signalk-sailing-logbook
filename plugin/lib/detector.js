/*
 * Source-agnostic detection logic.
 *
 * Both detectors are fed a stream of (timeMs, value) samples via feed(). The
 * exact same instances drive live detection (one sample at a time from Signal K
 * deltas) and retrospective detection (samples replayed from InfluxDB), so the
 * behaviour is identical regardless of source.
 *
 * Thresholds are passed in SI units:
 *   TripDetector      value = speedOverGround in m/s
 *   ManeuverDetector  value = angleTrueWater in radians (-pi..pi, negative = port)
 */

const KNOT = 0.514444

// ---- Trip detection --------------------------------------------------------

// State machine with hysteresis. Movement must persist for startMinMs before a
// trip starts; stillness must persist for stopMinMs before it stops. The trip's
// start/stop timestamps are the moment the qualifying condition *began*, not the
// moment it was confirmed, so the times reflect when the boat actually moved.
function createTripDetector (opts) {
  const startSpeed = (opts.startKnots != null ? opts.startKnots : 0.5) * KNOT
  const stopSpeed = (opts.stopKnots != null ? opts.stopKnots : 0.3) * KNOT
  const startMinMs = (opts.startMinSeconds != null ? opts.startMinSeconds : 180) * 1000
  const stopMinMs = (opts.stopMinSeconds != null ? opts.stopMinSeconds : 600) * 1000

  let moving = opts.initialMoving === true // resume an open trip across restarts
  let candidateSince = null // time when the opposite condition first held

  return {
    // onStart(timeMs) / onStop(timeMs) are optional callbacks.
    feed (timeMs, sog, onStart, onStop) {
      if (typeof timeMs !== 'number' || Number.isNaN(timeMs)) {
        return
      }
      if (typeof sog !== 'number' || Number.isNaN(sog)) {
        return
      }
      if (!moving) {
        if (sog >= startSpeed) {
          if (candidateSince == null) {
            candidateSince = timeMs
          } else if (timeMs - candidateSince >= startMinMs) {
            moving = true
            const startedAt = candidateSince
            candidateSince = null
            if (onStart) {
              onStart(startedAt)
            }
          }
        } else {
          candidateSince = null
        }
      } else {
        if (sog <= stopSpeed) {
          if (candidateSince == null) {
            candidateSince = timeMs
          } else if (timeMs - candidateSince >= stopMinMs) {
            moving = false
            const stoppedAt = candidateSince
            candidateSince = null
            if (onStop) {
              onStop(stoppedAt)
            }
          }
        } else {
          candidateSince = null
        }
      }
    },

    isMoving () {
      return moving
    },

    // Force-close an in-progress trip (e.g. plugin stop) at the given time.
    flush (timeMs, onStop) {
      if (moving) {
        moving = false
        candidateSince = null
        if (onStop) {
          onStop(timeMs)
        }
      }
    }
  }
}

// ---- Tack / gybe detection -------------------------------------------------

// A maneuver is a confirmed change of the wind side (port<->starboard) that the
// boat holds for at least holdMs on the new side. This rejects false tacks from
// the boat wandering across the wind while sails are hoisted or dropped.
//
// The side is read from a circular running mean of TWA over smoothMs, not from
// the raw sample. A masthead unit rolling in a seaway swings faster and wider
// than the wind actually shifts — measured at up to 45° between consecutive 1 Hz
// samples in light air and old swell, which is more than the flip it is supposed
// to detect — so raw TWA changes sides many times an hour with the boat holding
// its course. The mean is circular, so it crosses via 0° on a tack and via 180°
// on a gybe, keeping the entry angle that classifies the maneuver intact. All of
// the observed flutter lives below 5 s; 10 s leaves margin without noticeably
// delaying the timestamp.
//
// Which side the wind is on is the sign of that mean, but only when the boat is
// clearly on a side: samples within deadband of head-to-wind, or within
// runDeadband of dead-downwind, are "undecided" and ignored (near ±180° the sign
// flutters as the wind crosses dead astern — that is not a gybe). A brief flop
// back to the old side during a drawn-out maneuver does not reset it unless it
// persists for cancelGraceMs.
//
// The maneuver is classified by how the boat crossed the wind, read from the
// entry angle (|TWA| just before the flip): crossing the stern (downwind, entry
// > 90°) is a gybe, crossing the bow (upwind, entry < 90°) is a tack. This is
// robust even when the boat then heads up or bears away to a different angle.
//
// Each sample also carries the boat's speed (m/s). A maneuver only counts if the
// boat was above minSpeed at the flip: harbour manoeuvring and mooring turns
// happen at a crawl under engine and would otherwise register as false tacks.
// This is the best available "under sail" proxy without an engine-state signal.
// The speed compared against minSpeed is a median over a trailing window, not the
// latest sample: a paddle-wheel log alternates between the true speed and a
// fraction of it from one second to the next, and a tack is precisely where the
// boat slows through the wind, so a single sample decides the gate by luck.
const SPEED_WINDOW_MS = 30000

function createManeuverDetector (opts) {
  const holdMs = (opts.minTackSeconds != null ? opts.minTackSeconds : 90) * 1000
  const deadband = (opts.deadbandDeg != null ? opts.deadbandDeg : 5) * Math.PI / 180
  const runDeadband = (opts.runDeadbandDeg != null ? opts.runDeadbandDeg : 10) * Math.PI / 180
  const cancelGraceMs = (opts.cancelGraceSeconds != null ? opts.cancelGraceSeconds : 20) * 1000
  const minSpeed = opts.minSpeed != null ? opts.minSpeed : 0
  const smoothMs = (opts.smoothSeconds != null ? opts.smoothSeconds : 10) * 1000

  let sign = 0 // current confirmed side: -1 port, +1 starboard
  let entryMag = null // |TWA| of the last firmly-committed sample (entry angle)
  let entrySpeed = null // boat speed at that sample (m/s); the pre-maneuver speed
  let pending = null // { sign, since, backSince, twaBefore, twaAfter, speed }
  const angles = [] // trailing [timeMs, twa] window backing the circular mean
  const speeds = [] // trailing [timeMs, speed] window backing the median gate

  function sideOf (twa) {
    const mag = Math.abs(twa)
    if (mag <= deadband || mag >= Math.PI - runDeadband) {
      return 0 // near head-to-wind or dead-downwind: side undecided
    }
    return twa > 0 ? 1 : -1
  }

  // Mean direction of the window, taken as a vector so it wraps correctly: the
  // average of +179° and -179° is 180°, not 0°.
  function meanAngle (timeMs, twa) {
    angles.push([timeMs, twa])
    while (angles.length > 1 && timeMs - angles[0][0] > smoothMs) {
      angles.shift()
    }
    if (smoothMs <= 0) {
      return twa
    }
    let x = 0
    let y = 0
    for (const [, a] of angles) {
      x += Math.cos(a)
      y += Math.sin(a)
    }
    return Math.atan2(y, x)
  }

  function medianSpeed (timeMs, speed) {
    if (typeof speed === 'number' && !Number.isNaN(speed)) {
      speeds.push([timeMs, speed])
    }
    while (speeds.length && timeMs - speeds[0][0] > SPEED_WINDOW_MS) {
      speeds.shift()
    }
    if (speeds.length === 0) {
      return null
    }
    const v = speeds.map((s) => s[1]).sort((a, b) => a - b)
    const mid = v.length >> 1
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
  }

  return {
    // speed is the boat's speed (m/s) at this sample; pass null to skip gating.
    feed (timeMs, rawTwa, speed, onManeuver) {
      if (typeof timeMs !== 'number' || Number.isNaN(timeMs)) {
        return
      }
      if (typeof rawTwa !== 'number' || Number.isNaN(rawTwa)) {
        return
      }
      const twa = meanAngle(timeMs, rawTwa)
      const gateSpeed = medianSpeed(timeMs, speed)
      const side = sideOf(twa)
      if (side === 0) {
        return // undecided, keep last confirmed side and any pending flip
      }
      const mag = Math.abs(twa)

      if (sign === 0) {
        sign = side
        entryMag = mag
        entrySpeed = gateSpeed
        return // first fix, nothing to compare against
      }

      if (side === sign) {
        // Firmly on the committed side. A pending flip is only cancelled if the
        // boat stays back here for cancelGraceMs (tolerates flip-flop).
        if (pending) {
          if (pending.backSince == null) {
            pending.backSince = timeMs
          } else if (timeMs - pending.backSince >= cancelGraceMs) {
            pending = null
          }
        }
        entryMag = mag
        entrySpeed = gateSpeed
        return
      }

      // Opposite side. Gate on the pre-maneuver speed (entrySpeed): a real tack
      // may momentarily slow through the wind, but it was sailing beforehand;
      // harbour turns crawl throughout.
      if (pending == null || pending.sign !== side) {
        pending = { sign: side, since: timeMs, backSince: null, twaBefore: entryMag, twaAfter: mag, speed: entrySpeed }
        return
      }
      pending.backSince = null // back on the new side; reset the cancel timer
      pending.twaAfter = mag
      if (timeMs - pending.since >= holdMs) {
        const tooSlow = minSpeed > 0 && pending.speed != null && pending.speed < minSpeed
        const type = pending.twaBefore != null && pending.twaBefore > Math.PI / 2 ? 'gybe' : 'tack'
        const ev = { time: pending.since, type, twaBefore: pending.twaBefore, twaAfter: pending.twaAfter }
        sign = side
        entryMag = mag
        entrySpeed = gateSpeed
        pending = null
        // The side did change, so commit it; only suppress the count when slow.
        if (!tooSlow && onManeuver) {
          onManeuver(ev)
        }
      }
    }
  }
}

module.exports = { createTripDetector, createManeuverDetector, KNOT }
