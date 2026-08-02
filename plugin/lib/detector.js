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

// Speed over ground alone is a poor test of whether the boat is going anywhere.
// Lying to a mooring, GPS noise puts the 30 s mean at 0.2–0.5 kn on a boat that
// stays inside 10 metres for an hour: enough to reset the stop timer every few
// minutes and keep a finished trip open indefinitely (observed 2026-08-02), and
// enough to touch the start threshold in a gust. The position trail settles both
// questions where speed cannot — the whole range over the stop window was 12 m
// at the buoy against 98 m for the slowest window of the approach that day.
//
// Stopping: every fix across the stop window lies within stopSpreadMeters of the
// others. That condition already spans the full window, so it ends the trip at
// once, backdated to the window's start.
//
// Starting: the boat must also have gone somewhere — at least half the distance
// the start threshold speed would cover in startMinMs. Swinging round a buoy
// never adds up to that however the reported speed behaves.
//
// Both tests abstain unless the trail actually covers the window in question: no
// fixes, or a hole in them, must never end a trip nor hold one back.
const FIX_GAP_MS = 120000 // a hole this long means the trail doesn't cover it
const MIN_FIXES = 5
const M_PER_DEG = 111320

function metres (lat1, lon1, lat2, lon2) {
  const mPerLon = M_PER_DEG * Math.cos(((lat1 + lat2) / 2 * Math.PI) / 180)
  return Math.hypot((lat1 - lat2) * M_PER_DEG, (lon1 - lon2) * mPerLon)
}

// State machine with hysteresis. Movement must persist for startMinMs before a
// trip starts; stillness must persist for stopMinMs before it stops. The trip's
// start/stop timestamps are the moment the qualifying condition *began*, not the
// moment it was confirmed, so the times reflect when the boat actually moved.
function createTripDetector (opts) {
  const startSpeed = (opts.startKnots != null ? opts.startKnots : 0.5) * KNOT
  const stopSpeed = (opts.stopKnots != null ? opts.stopKnots : 0.3) * KNOT
  const startMinMs = (opts.startMinSeconds != null ? opts.startMinSeconds : 180) * 1000
  const stopMinMs = (opts.stopMinSeconds != null ? opts.stopMinSeconds : 600) * 1000
  const stopSpread = opts.stopSpreadMeters != null ? opts.stopSpreadMeters : 50
  const minDisplacement = (startSpeed * startMinMs) / 1000 / 2
  // Position only overrules speed while the speed is low enough to be consistent
  // with lying still. A frozen GPS reporting the same coordinate at 5 kn, or a
  // boat working back and forth in front of a bridge, must not read as moored.
  const confinedMaxSpeed = Math.max(KNOT, stopSpeed)

  let moving = opts.initialMoving === true // resume an open trip across restarts
  let movingSince = null // when the current trip began; null when resumed
  let candidateSince = null // time when the opposite condition first held
  const trail = [] // [timeMs, lat, lon], covering the longer hysteresis window

  // The fixes covering [from, to], or null when the trail can't speak for that
  // span: too few of them, starting or ending too far inside it, or holed.
  function windowFixes (from, to) {
    const win = trail.filter((p) => p[0] >= from && p[0] <= to)
    if (win.length < MIN_FIXES) {
      return null
    }
    if (win[0][0] - from > FIX_GAP_MS || to - win[win.length - 1][0] > FIX_GAP_MS) {
      return null
    }
    for (let i = 1; i < win.length; i++) {
      if (win[i][0] - win[i - 1][0] > FIX_GAP_MS) {
        return null
      }
    }
    return win
  }

  // Has the boat stayed put across the whole stop window? Measured as the
  // diagonal of the bounding box, which is never smaller than the true largest
  // distance between two fixes, so it errs towards leaving the trip open.
  // Returns the fixes it judged, so the stop can be dated to the first of them
  // rather than to a window edge the trail may not quite reach back to.
  function confined (timeMs, sog) {
    if (!(stopSpread > 0) || sog > confinedMaxSpeed) {
      return null
    }
    // The window has to lie wholly inside the trip, or the stop it produces
    // would predate the start it is meant to end.
    if (movingSince != null && timeMs - stopMinMs < movingSince) {
      return null
    }
    const win = windowFixes(timeMs - stopMinMs, timeMs)
    if (!win) {
      return null
    }
    let minLat = Infinity
    let maxLat = -Infinity
    let minLon = Infinity
    let maxLon = -Infinity
    for (const [, lat, lon] of win) {
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
      minLon = Math.min(minLon, lon)
      maxLon = Math.max(maxLon, lon)
    }
    return metres(minLat, minLon, maxLat, maxLon) <= stopSpread ? win : null
  }

  // Net displacement over the last startMinMs. Unknown (no usable trail) counts
  // as departed: the speed rule is then the only evidence there is. The window
  // is the recent one rather than the whole candidate stretch, which grows
  // without bound while the speed stays up — once it outgrew the trail the
  // trail could no longer answer, and the rule fell open on exactly the boat it
  // was holding back.
  function departed (from, to) {
    if (!(stopSpread > 0)) {
      return true
    }
    const win = windowFixes(Math.max(from, to - startMinMs), to)
    if (!win) {
      return true
    }
    const a = win[0]
    const b = win[win.length - 1]
    return metres(a[1], a[2], b[1], b[2]) >= minDisplacement
  }

  return {
    // Position fixes feed the trail that both rules read. Optional: without them
    // the detector behaves exactly as it did on speed alone.
    feedPosition (timeMs, lat, lon) {
      if (typeof timeMs !== 'number' || Number.isNaN(timeMs)) {
        return
      }
      if (typeof lat !== 'number' || Number.isNaN(lat)) {
        return
      }
      if (typeof lon !== 'number' || Number.isNaN(lon)) {
        return
      }
      // A time that jumps backwards (a restart, a replayed scan) invalidates the
      // trail rather than leaving it interleaved with the new one.
      if (trail.length && timeMs < trail[trail.length - 1][0]) {
        trail.length = 0
      }
      trail.push([timeMs, lat, lon])
      // Keep a fix gap's slack beyond the window itself: live, the trail is fed
      // at wall-clock time while the speed samples carry the start time of a
      // bucket flushed up to a minute later, so the window a rule asks about
      // reaches further back than the fix that just arrived.
      const keepMs = Math.max(startMinMs, stopMinMs) + FIX_GAP_MS
      while (trail.length && trail[0][0] < timeMs - keepMs) {
        trail.shift()
      }
    },

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
          } else if (timeMs - candidateSince >= startMinMs && departed(candidateSince, timeMs)) {
            moving = true
            const startedAt = candidateSince
            movingSince = startedAt
            candidateSince = null
            if (onStart) {
              onStart(startedAt)
            }
          }
        } else {
          candidateSince = null
        }
      } else {
        // The boat has not left a 50 m circle in ten minutes: whatever the log
        // says about speed, the trip is over.
        const still = confined(timeMs, sog)
        if (still) {
          moving = false
          movingSince = null
          candidateSince = null
          if (onStop) {
            onStop(Math.max(timeMs - stopMinMs, still[0][0]))
          }
          return
        }
        if (sog <= stopSpeed) {
          if (candidateSince == null) {
            candidateSince = timeMs
          } else if (timeMs - candidateSince >= stopMinMs) {
            moving = false
            movingSince = null
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
        movingSince = null
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
// Changing sides is not the same as tacking. Rounding up to drop sails under
// engine, the bow wanders across the wind and stays there: on 2026-08-02 that
// logged a tack whose angle went from 5.5° on one side to 5.3° on the other,
// the boat never bearing away onto anything. So a maneuver must also reach a
// real new tack — settleAngle off the wind — at some point within the hold
// window. Reaching it and luffing up again still counts; the boat did tack.
//
// That angle is read from the *apparent* wind, fed separately via feedApparent,
// even though the side itself is read from the true wind angle. The masthead
// measures apparent directly, while true wind is derived from it and the speed
// through water — so a fouled paddlewheel collapses true onto apparent and would
// drag any true-wind threshold down with it, silently rejecting every tack of the
// day. The apparent angle cannot be moved by a broken log. It is also the smaller
// of the two on the wind (a boat beating at 40-45° true carries 25-28° apparent),
// so the threshold is set against that.
//
// Measured off the wind, the threshold only ever bites on a tack. A gybe leaves
// the boat somewhere near dead-downwind — two real ones on 2026-08-02, forced by
// backwinding under a high island, came out at 168.8° and 148.9° true — which
// clears any sane figure by a mile. That asymmetry is the point: a gybe is
// settled by the wind crossing the stern, and requiring it to also lie a set
// angle off dead-downwind would throw away perfectly good ones.
//
// With no apparent wind fed at all the requirement is dropped rather than
// guessed at: a missing sensor must not quietly delete maneuvers.
//
// The side change is committed either way. The boat really is on the other
// side, and pretending otherwise would leave the detector hunting a crossing
// that has already happened.
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
// An apparent angle older than this judges nothing. Both paths feed it at 1 Hz,
// so this is a wide margin — but it must stay well inside the hold window, or a
// masthead that falls silent as the boat crosses the wind would leave the angle
// caught mid-crossing standing as the verdict on where she ended up, and condemn
// a real tack. Short of fresh evidence the requirement lapses instead.
const AWA_MAX_AGE_MS = 15000

function createManeuverDetector (opts) {
  const holdMs = (opts.minTackSeconds != null ? opts.minTackSeconds : 90) * 1000
  const deadband = (opts.deadbandDeg != null ? opts.deadbandDeg : 5) * Math.PI / 180
  const runDeadband = (opts.runDeadbandDeg != null ? opts.runDeadbandDeg : 10) * Math.PI / 180
  const cancelGraceMs = (opts.cancelGraceSeconds != null ? opts.cancelGraceSeconds : 20) * 1000
  const minSpeed = opts.minSpeed != null ? opts.minSpeed : 0
  const smoothMs = (opts.smoothSeconds != null ? opts.smoothSeconds : 10) * 1000
  const settleAngle = (opts.newTackMinAwaDeg != null ? opts.newTackMinAwaDeg : 20) * Math.PI / 180

  let sign = 0 // current confirmed side: -1 port, +1 starboard
  let entryMag = null // |TWA| of the last firmly-committed sample (entry angle)
  let entrySpeed = null // boat speed at that sample (m/s); the pre-maneuver speed
  let pending = null // { sign, since, backSince, twaBefore, twaAfter, speed }
  const apparents = [] // trailing [timeMs, |awa|] backing the mean below
  let lastAwa = null // mean |apparent wind angle|, the new-tack test's yardstick
  let lastAwaAt = null // and when it arrived; a stale one is no yardstick at all
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
    // The apparent wind angle (radians), which the new-tack test is judged by.
    // Optional: with none of these the test is skipped entirely.
    //
    // Averaged over the same window as the side, and for the same reason: the
    // test asks how far off the wind the boat ever got, so a single noisy sample
    // would otherwise settle it. On 2026-08-02 the manoeuvre this rule exists to
    // reject carried one 20.9° reading, lasting a second, in three quarters of a
    // minute otherwise spent inside 8°.
    //
    // Averaged as a vector, like the side, and then taken as a magnitude — not
    // the other way round. Averaging |angle| would read a vane swinging ±25°
    // across the wind, which is exactly what it does with the boat head to wind
    // and the genoa flogging, as a steady 25° off it. As a vector that flutter
    // cancels to nearly nothing, which is the truth: she is not on a new tack.
    feedApparent (timeMs, awa) {
      if (typeof timeMs !== 'number' || Number.isNaN(timeMs)) {
        return
      }
      if (typeof awa !== 'number' || Number.isNaN(awa)) {
        return
      }
      // A time that jumps backwards (a restart, a replayed scan) invalidates the
      // window rather than leaving two runs interleaved in it.
      if (apparents.length && timeMs < apparents[apparents.length - 1][0]) {
        apparents.length = 0
      }
      if (smoothMs <= 0) {
        apparents.length = 0
        lastAwa = Math.abs(awa)
        lastAwaAt = timeMs
        return
      }
      apparents.push([timeMs, awa])
      while (apparents.length > 1 && timeMs - apparents[0][0] > smoothMs) {
        apparents.shift()
      }
      let x = 0
      let y = 0
      for (const [, a] of apparents) {
        x += Math.cos(a)
        y += Math.sin(a)
      }
      lastAwa = Math.abs(Math.atan2(y, x))
      lastAwaAt = timeMs
    },

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
      const awaAge = lastAwaAt != null ? timeMs - lastAwaAt : null
      const awa = awaAge != null && awaAge >= 0 && awaAge <= AWA_MAX_AGE_MS ? lastAwa : null
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
        pending = {
          sign: side,
          since: timeMs,
          backSince: null,
          twaBefore: entryMag,
          twaAfter: mag,
          // Furthest off the wind reached on the new side, apparent. Null until
          // an apparent angle has been fed, which drops the requirement.
          maxAwa: awa,
          speed: entrySpeed
        }
        return
      }
      pending.backSince = null // back on the new side; reset the cancel timer
      pending.twaAfter = mag
      if (awa != null) {
        pending.maxAwa = Math.max(pending.maxAwa != null ? pending.maxAwa : 0, awa)
      }
      if (timeMs - pending.since >= holdMs) {
        const tooSlow = minSpeed > 0 && pending.speed != null && pending.speed < minSpeed
        const type = pending.twaBefore != null && pending.twaBefore > Math.PI / 2 ? 'gybe' : 'tack'
        // The maneuver has to have arrived somewhere — but only where there is
        // current evidence to say it did not. A masthead that has gone quiet
        // cannot condemn it.
        const unsettled = awa != null && pending.maxAwa != null && pending.maxAwa < settleAngle
        const ev = {
          time: pending.since,
          type,
          twaBefore: pending.twaBefore,
          twaAfter: pending.twaAfter,
          // How far off the wind she actually got, apparent, or null where no
          // apparent wind was available to judge by. Reported so a maneuver that
          // passed unjudged is visible rather than silent.
          newTackAngle: awa != null ? pending.maxAwa : null
        }
        sign = side
        entryMag = mag
        entrySpeed = gateSpeed
        pending = null
        // The side did change, so commit it; only suppress the count.
        if (!tooSlow && !unsettled && onManeuver) {
          onManeuver(ev)
        }
      }
    }
  }
}

// The speed the maneuver gate should judge a tack by. Normally the log, which
// measures what actually flows past the hull. But a paddlewheel fouls, and a
// blocked impeller does not fail loudly — it reads a flat zero, and the gate
// then drops every maneuver of the day as harbour manoeuvring by a drifting
// boat (a whole passage of them on 2026-08-01, weed on the wheel).
//
// A log reading exactly nothing is a log that is not reading: a sailing boat
// always has some water going past the hull. So zero, like a missing value,
// hands the gate over to speed over ground, which nothing growing on the hull
// can block. Any positive reading is taken at face value however low it looks
// beside SOG — a current can legitimately hold the log well under the ground
// track, and second-guessing that would throw away a real measurement.
//
// The zero has to last, though: a dropped sample or a wheel that stalls for a
// moment in a lull is not a fouled log, and switching sources on one reading
// would make the gate flicker between two speeds mid-maneuver. Only once the
// zero has held for zeroSeconds does the ground track take over, and the first
// positive reading hands it straight back.
const ZERO_RUN_SECONDS = 30
function createSpeedGate (opts) {
  const zeroMs = ((opts && opts.zeroSeconds != null ? opts.zeroSeconds : ZERO_RUN_SECONDS)) * 1000
  let zeroSince = null
  return {
    speedAt (timeMs, stw, sog) {
      if (stw != null && stw > 0) {
        zeroSince = null
        return stw
      }
      // A time that jumps backwards (a restart, a replayed scan) starts a fresh
      // run rather than one of negative length.
      if (zeroSince == null || timeMs < zeroSince) {
        zeroSince = timeMs
      }
      return sog != null && timeMs - zeroSince >= zeroMs ? sog : stw
    }
  }
}

module.exports = { createTripDetector, createManeuverDetector, createSpeedGate, KNOT }
