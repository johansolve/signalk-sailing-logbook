/*
 * signalk-sailing-logbook
 *
 * Automatic logbook. A source-agnostic state machine detects trips from SOG and
 * marks tacks/gybes from the true wind angle; only these events are persisted to
 * SQLite. Hourly wind and heel statistics are computed on demand from the
 * onboard InfluxDB, so nothing is duplicated.
 *
 * Live detection feeds the state machine one sample at a time using server
 * receive time (Date.now()), deliberately ignoring each delta's own timestamp
 * because the eMux GPS source sometimes reports a wrong (year-2061) time.
 * Retrospective scanning replays InfluxDB history through the same machine.
 */

const path = require('path')
const dbLib = require('./lib/db')
const influxLib = require('./lib/influx')
const geocode = require('./lib/geocode')
const report = require('./lib/report')
const { createTripDetector, createManeuverDetector, createSpeedGate, KNOT } = require('./lib/detector')
const { fromStateSeries } = require('./lib/engine')

const NM = 1852 // metres per nautical mile

// Live SOG is smoothed into fixed 30 s means before it reaches the trip
// detector, matching exactly how the retrospective scan feeds it (influx
// sogSeries: mean(value) GROUP BY time(30s)). Raw ~2 Hz SOG jitters over the
// stop threshold at the quay, which would forever reset the stop timer and
// leave a trip open; the mean does not. Buckets are epoch-aligned like
// InfluxDB's, so a given wall-clock window yields the same sample live and
// retrospectively. This is kept in-memory rather than polled from InfluxDB so
// live detection stays independent of it (a down or lagging InfluxDB must not
// stop trips being logged).
const SOG_BUCKET_MS = 30000

module.exports = function (app) {
  const plugin = {}
  let db = null
  let influx = null
  let options = {}
  let unsubscribes = []
  let tripDetector = null
  let maneuverDetector = null
  let currentTripId = null
  let lastPosition = null // { lat, lon }
  // A trail of recent fixes, [timeMs, lat, lon]. The trip detector reports when
  // movement began or ended, a whole hysteresis window before we hear about it,
  // and by then the boat is somewhere else: three minutes out of the anchorage on
  // a start. The trail lets a trip be anchored where it actually began or ended.
  let positionTrail = []
  let lastSTW = null // most recent speed through water (m/s), for the maneuver gate
  let lastSOG = null // most recent speed over ground, the gate's fallback
  let speedGate = null // decides between the two (see createSpeedGate)
  let fouledLogSeen = false // so the fallback is reported once, not per sample
  let unjudgedManeuverSeen = false // likewise for a missing apparent wind angle
  let liveEngineState = null // last propulsion.<n>.state value we've seen
  let liveEngineOnSince = null // ms when it last changed to 'started', for the gate
  let geocodeEnabled = true
  // Accumulator for the current 30 s SOG mean fed to the trip detector.
  let sogBucketStart = null // epoch-aligned start of the bucket being filled (ms)
  let sogBucketSum = 0
  let sogBucketCount = 0

  plugin.id = 'signalk-sailing-logbook'
  plugin.name = 'Sailing Logbook'
  plugin.description =
    'Automatic logbook: detects trips from SOG, logs tacks/gybes, and reports ' +
    'hourly wind and heel statistics from the onboard InfluxDB.'

  plugin.schema = {
    type: 'object',
    properties: {
      dbPath: {
        type: 'string',
        title: 'SQLite file path',
        description: "Leave blank to use the plugin's data directory. Point it at an SSD if that sits on an SD card.",
        default: ''
      },
      startKnots: {
        type: 'number',
        title: 'Trip starts above this SOG (knots)',
        default: 0.5
      },
      stopKnots: {
        type: 'number',
        title: 'Trip stops below this SOG (knots)',
        default: 0.3
      },
      startMinSeconds: {
        type: 'number',
        title: 'Movement must persist this long to start a trip (s)',
        default: 180
      },
      stopMinSeconds: {
        type: 'number',
        title: 'Stillness must persist this long to end a trip (s)',
        default: 600
      },
      stopSpreadMeters: {
        type: 'number',
        title: 'Also end a trip when every position fix over that window stays within this many metres (0 = off)',
        description: 'Lying to a mooring or anchor, GPS noise alone keeps the reported speed above the stop threshold and a finished trip open. The same trail also holds a trip back from starting until the boat has actually left, which a swing round the buoy never does.',
        default: 50
      },
      minNewTackSeconds: {
        type: 'number',
        title: 'Minimum seconds on the new tack for a maneuver to count (rejects false tacks while hoisting/dropping sails)',
        default: 90
      },
      runDeadbandDeg: {
        type: 'number',
        title: 'Degrees past dead-downwind before a side counts (ignores TWA flutter near a dead run)',
        default: 10
      },
      newTackMinAwaDeg: {
        type: 'number',
        title: 'A maneuver must reach at least this apparent wind angle on the new side to count',
        description: 'Rounding up to drop sails, the bow crosses the wind and stays there without ever bearing away onto a new tack. Judged on apparent wind, which the masthead measures directly and a fouled log cannot drag down. Set it below your close-hauled apparent angle; measured off the wind it only ever bites on a tack, since a gybe leaves you near dead-downwind anyway. 0 switches the rule off.',
        default: 20,
        minimum: 0
      },
      twaSmoothingSeconds: {
        type: 'number',
        title: 'Average TWA over this many seconds before reading the wind side (rejects masthead swing in a seaway)',
        default: 10
      },
      minSailingSpeedKnots: {
        type: 'number',
        title: 'Minimum boat speed (STW, knots) for a maneuver to count (rejects harbour/mooring turns under engine)',
        default: 2
      },
      maneuverEdgeMarginMinutes: {
        type: 'number',
        title: 'Ignore maneuvers within this many minutes of a trip start/end (harbour departure and mooring)',
        default: 5
      },
      maneuverEdgeRadiusMeters: {
        type: 'number',
        title: 'Ignore maneuvers within this many metres of the start/end position (harbour)',
        default: 200
      },
      engineAware: {
        type: 'boolean',
        title: 'Use engine state (from the path below) to drop maneuvers made under engine and flag motoring trips',
        default: true
      },
      engineStatePath: {
        type: 'string',
        title: 'Propulsion state path from an engine-state provider (read live and from InfluxDB)',
        description: 'Published by signalk-derived-engine-state or a similar plugin. Used to drop maneuvers made under engine, both live and at completion.',
        default: 'propulsion.0.state'
      },
      motorTripPercent: {
        type: 'number',
        title: 'Flag a trip as motoring when at least this percent of it was under engine',
        default: 85
      },
      geocode: {
        type: 'boolean',
        title: 'Look up place names via OpenStreetMap Nominatim',
        default: true
      },
      placeRadiusMeters: {
        type: 'number',
        title: 'Reuse a named place for any trip starting/ending within this radius (m)',
        description: 'Naming a place in the webapp applies it to every trip, past and future, whose start or stop is within this distance of it.',
        default: 250
      },
      influxHost: { type: 'string', title: 'InfluxDB host', default: 'localhost' },
      influxPort: { type: 'number', title: 'InfluxDB port', default: 8086 },
      database: { type: 'string', title: 'InfluxDB database', default: 'libelle' },
      username: { type: 'string', title: 'InfluxDB username (blank if auth off)', default: '' },
      password: { type: 'string', title: 'InfluxDB password (blank if auth off)', default: '' }
    }
  }

  // ---- detection wiring ----------------------------------------------------

  function positionNow () {
    if (lastPosition) {
      return lastPosition
    }
    const p = app.getSelfPath('navigation.position')
    if (p && p.value && typeof p.value.latitude === 'number') {
      return { lat: p.value.latitude, lon: p.value.longitude }
    }
    return null
  }

  // Keep the trail reaching back past the longer of the two hysteresis windows,
  // which is as far as a reported time is ever backdated.
  function trailWindowMs () {
    const start = options.startMinSeconds != null ? options.startMinSeconds : 180
    const stop = options.stopMinSeconds != null ? options.stopMinSeconds : 600
    return (Math.max(start, stop) + 60) * 1000
  }

  // Where we were at a given moment: the fix nearest it in time, provided one is
  // within a minute of it. A time the trail doesn't reach (the plugin restarted
  // mid-passage, or position deltas have stopped arriving) falls back to the
  // current position, which is the only estimate left.
  function positionAt (timeMs) {
    let best = null
    let bd = Infinity
    for (const [t, lat, lon] of positionTrail) {
      const d = Math.abs(t - timeMs)
      if (d < bd) {
        bd = d
        best = { lat, lon }
      }
    }
    return bd <= 60000 ? best : positionNow()
  }

  function geocodeTrip (tripId, which, lat, lon) {
    if (!geocodeEnabled || lat == null || lon == null) {
      return
    }
    geocode
      .reverse(lat, lon)
      .then((name) => {
        // The plugin may have stopped during the reverse-geocode request.
        if (name && db) {
          db.setGeocode(tripId, which === 'start' ? { startPlace: name } : { stopPlace: name })
        }
      })
      .catch((e) => app.debug(`geocode failed: ${e.message}`))
  }

  function onTripStart (startedAt) {
    const pos = positionAt(startedAt) || {}
    currentTripId = db.createActiveTrip({
      startTime: startedAt,
      lat: pos.lat,
      lon: pos.lon,
      origin: 'live'
    })
    app.setPluginStatus(`Trip started ${new Date(startedAt).toISOString()}`)
    geocodeTrip(currentTripId, 'start', pos.lat, pos.lon)
  }

  function onTripStop (stoppedAt) {
    const tripId = currentTripId
    currentTripId = null
    if (tripId == null) {
      return
    }
    const trip = db.getTrip(tripId)
    const pos = positionAt(stoppedAt) || {}
    completeTripAsync(tripId, trip.start_time, stoppedAt, pos)
    app.setPluginStatus(`Trip ended ${new Date(stoppedAt).toISOString()}`)
  }

  // Accumulate raw SOG into epoch-aligned 30 s means and feed the trip detector
  // one mean per bucket, mirroring the retrospective scan. A bucket is flushed
  // when the first sample of the next bucket arrives, so the detector sees the
  // same smoothed series live and retrospectively. The in-progress bucket lags
  // by up to 30 s, which is immaterial next to the 3/10 min start/stop hysteresis.
  function feedSog (now, sog) {
    if (Number.isNaN(sog)) {
      return // a bad sample must skip, not poison the whole bucket's mean
    }
    const bucket = Math.floor(now / SOG_BUCKET_MS) * SOG_BUCKET_MS
    if (sogBucketStart != null && bucket !== sogBucketStart) {
      tripDetector.feed(
        sogBucketStart,
        sogBucketSum / sogBucketCount,
        onTripStart,
        onTripStop
      )
      sogBucketSum = 0
      sogBucketCount = 0
    }
    sogBucketStart = bucket
    sogBucketSum += sog
    sogBucketCount += 1
  }

  async function completeTripAsync (tripId, startMs, stopMs, stopPos) {
    let distanceNm = null
    let maxStw = null
    try {
      const agg = await influx.tripAggregate(startMs, stopMs)
      if (agg.meanSog != null) {
        distanceNm = (agg.meanSog * (stopMs - startMs)) / 1000 / NM
      }
      maxStw = agg.maxStw
    } catch (e) {
      app.error(`trip aggregate failed: ${e.message}`)
    }
    // Everything below touches the DB after an await, so guard against the plugin
    // having been stopped meanwhile (db set to null) and against any DB error, so
    // a late completion can't crash as an unhandled rejection.
    try {
      if (!db) {
        return
      }
      db.completeTrip(tripId, {
        stopTime: stopMs,
        stopLat: stopPos.lat,
        stopLon: stopPos.lon,
        distanceNm,
        maxStw
      })
      // Now that the end is known, drop maneuvers near it in time or distance
      // (dropping sails, mooring turns) or while the engine was running, and
      // record how much of the trip was under engine.
      const completed = db.getTrip(tripId)
      const engine = await analyzeTripEngine(startMs, stopMs)
      if (!db) {
        return
      }
      db.getEvents(tripId).forEach((e) => {
        if (isEdgeManeuver(completed, e.time, e.lat, e.lon) || engine.onAt(e.time)) {
          db.deleteEvent(e.id)
        }
      })
      if (engine.share != null) {
        db.setEngineShare(tripId, engine.share)
      }
    } catch (e) {
      app.error(`trip completion failed: ${e.message}`)
      return
    }
    geocodeTrip(tripId, 'stop', stopPos.lat, stopPos.lon)
  }

  // Track the propulsion.<n>.state published by an engine-state provider. We keep
  // our own "on since" moment, updated only when the value actually changes, so we
  // never depend on how the provider paces its deltas: a provider that re-emits
  // "started" every sample and one that emits only on a transition both yield the
  // same on-since here (we ignore repeats of the current value). Feed uses server
  // receive time (Date.now()), the same clock the maneuver detector runs on.
  function onEngineState (value, now) {
    if (value === liveEngineState) {
      return
    }
    liveEngineState = value
    if (value === 'started') {
      liveEngineOnSince = now
    }
  }

  // Seed the live engine state at start from whatever the data model already holds,
  // so a plugin restart mid-motoring suppresses right away instead of waiting for
  // the next transition. Best-effort: use the retained value's timestamp as the
  // on-since, falling back to 0 ("on since before this trip") when it's missing.
  function seedEngineState () {
    const p = app.getSelfPath(options.engineStatePath || 'propulsion.0.state')
    if (!p || p.value == null) {
      return
    }
    liveEngineState = p.value
    if (p.value === 'started') {
      const ts = p.timestamp ? Date.parse(p.timestamp) : NaN
      liveEngineOnSince = Number.isFinite(ts) ? ts : 0
    }
  }

  // Was the engine running at time t? We compare against t (the maneuver's own
  // moment), not "now": a maneuver is only confirmed after a hold (default 90 s),
  // by which time the engine may have been started for the motoring leg that
  // follows. A tack made just before the engine started (onSince > t) is therefore
  // not treated as under engine and survives. Unknown/absent state means don't
  // suppress; completion still reconciles genuine motoring against InfluxDB.
  function engineOnAt (t) {
    if (options.engineAware === false) {
      return false
    }
    return liveEngineState === 'started' && liveEngineOnSince != null && liveEngineOnSince <= t
  }

  function edgeMarginMs () {
    return (options.maneuverEdgeMarginMinutes != null ? options.maneuverEdgeMarginMinutes : 5) * 60000
  }
  function edgeRadiusM () {
    return options.maneuverEdgeRadiusMeters != null ? options.maneuverEdgeRadiusMeters : 200
  }

  // Engine-on analysis over a trip window, read from propulsion.<n>.state as
  // published (live) and backfilled (history) by signalk-derived-engine-state. The
  // detection logic lives there, not here. Degrades to "unknown / not motor"
  // when there is no state for the window.
  async function analyzeTripEngine (startMs, stopMs) {
    if (options.engineAware === false) {
      return { onAt: () => false, share: null }
    }
    try {
      const fromState = fromStateSeries(await influx.engineStateSeries(startMs, stopMs))
      if (fromState) {
        return fromState
      }
      return { onAt: () => false, share: null }
    } catch (e) {
      app.error(`engine analysis failed: ${e.message}`)
      return { onAt: () => false, share: null }
    }
  }

  // Great-circle distance in metres.
  function haversine (aLat, aLon, bLat, bLon) {
    const R = 6371000
    const toRad = (d) => (d * Math.PI) / 180
    const dLat = toRad(bLat - aLat)
    const dLon = toRad(bLon - aLon)
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
  }

  // ---- named places --------------------------------------------------------
  // A user-given name anchored at a position, reused for every trip that starts
  // or ends within placeRadiusMeters of it (past and future). The registry lives
  // in SQLite; matching is a small in-memory scan since there are only a handful.

  function placeRadiusM () {
    return options.placeRadiusMeters != null ? options.placeRadiusMeters : 250
  }

  // Nearest named place within the radius of a position, or null.
  function nearestPlace (lat, lon) {
    if (lat == null || lon == null || !db) {
      return null
    }
    const r = placeRadiusM()
    let best = null
    let bd = Infinity
    for (const p of db.listPlaces()) {
      const d = haversine(lat, lon, p.lat, p.lon)
      if (d <= r && d < bd) {
        bd = d
        best = p
      }
    }
    return best
  }

  function resolvePlaceName (lat, lon) {
    const p = nearestPlace(lat, lon)
    return p ? p.name : null
  }

  // Set a name at a position: rename the nearest place within the radius, or add
  // a new one anchored here if there is none.
  function upsertPlaceAt (lat, lon, name) {
    if (lat == null || lon == null) {
      return
    }
    const near = nearestPlace(lat, lon)
    if (near) {
      db.updatePlaceName(near.id, name)
    } else {
      db.insertPlace({ name, lat, lon })
    }
  }

  // Clear the name at a position by removing the nearest place within the radius,
  // reverting every trip near it to its geocoded name.
  function deletePlaceAt (lat, lon) {
    const near = nearestPlace(lat, lon)
    if (near) {
      db.deletePlace(near.id)
    }
  }

  // Apply one edited side (start or stop) from the form. `geo` is the geocoded
  // name, `submitted` the field value. Saving only ever creates or renames: it
  // never deletes, so re-saving an unchanged form (which always sends both sides)
  // can't remove a shared place, and an emptied field is a no-op. Deletion is an
  // explicit action (see the DELETE route). We also skip when the submitted value
  // equals what the field already shows, so leaving a geocoded name untouched
  // doesn't pin it into the registry.
  function applyPlaceEdit (lat, lon, geo, submitted) {
    if (lat == null || lon == null) {
      return
    }
    const name = typeof submitted === 'string' && submitted.trim() ? submitted.trim() : null
    if (name == null) {
      return
    }
    const current = resolvePlaceName(lat, lon)
    const effective = current != null ? current : (geo || null)
    if (name === effective) {
      return
    }
    upsertPlaceAt(lat, lon, name)
  }

  // Overlay the resolved place names onto a trip row for display. The registry is
  // the single source for manual names, so we set the *_place_manual fields from
  // it (null when unnamed), and the geocoded *_place stays as the fallback. When a
  // point has no coordinates (registry can't anchor it) we keep whatever manual
  // name the row already carried, so a coordless legacy name isn't lost.
  //
  // same_place flags a round trip whose start and stop fall within the radius:
  // they are one place by definition, so the webapp shows a single name field for
  // them instead of two that could disagree.
  function withPlaces (trip) {
    if (!trip) {
      return trip
    }
    const startName = resolvePlaceName(trip.start_lat, trip.start_lon)
    const stopName = resolvePlaceName(trip.stop_lat, trip.stop_lon)
    const samePlace =
      trip.start_lat != null && trip.stop_lat != null &&
      haversine(trip.start_lat, trip.start_lon, trip.stop_lat, trip.stop_lon) <= placeRadiusM()
    const out = Object.assign({}, trip, {
      start_place_manual: startName != null ? startName : (trip.start_lat == null ? trip.start_place_manual : null),
      stop_place_manual: stopName != null ? stopName : (trip.stop_lat == null ? trip.stop_place_manual : null),
      same_place: samePlace
    })
    // The hourly-stats cache blob is internal; never ship it in an API response.
    delete out.hourly_json
    return out
  }

  // One-time seed: turn the manual names that predate the registry into places,
  // so existing trips keep their names and share them. Guarded by user_version so
  // it runs once and never resurrects a place the user later deletes.
  function seedPlacesOnce () {
    if (db.userVersion() >= 1) {
      return
    }
    // Oldest first, so when two manual names fall within one radius (the same
    // place by our model) the most recent naming wins the merge.
    db.listTrips().slice().reverse().forEach((t) => {
      if (t.start_place_manual) {
        upsertPlaceAt(t.start_lat, t.start_lon, t.start_place_manual)
      }
      if (t.stop_place_manual) {
        upsertPlaceAt(t.stop_lat, t.stop_lon, t.stop_place_manual)
      }
    })
    db.setUserVersion(1)
  }

  // One-time backfill: (re)compute max_stw from InfluxDB for every complete
  // trip, sequentially so we don't flood the DB. Guarded by user_version so it
  // runs once; a trip whose window has no STW data stays null and simply shows
  // no max. Runs in the background — start() must not block on it. Version 3
  // recomputes for all trips (version 2 briefly stored a raw max that the
  // paddle-wheel spikes polluted; the p99 peak replaces it).
  async function backfillMaxStwOnce () {
    if (db.userVersion() >= 3) {
      return
    }
    const trips = db.completeTripWindows()
    let ok = 0
    let failed = 0
    for (const t of trips) {
      if (!db) {
        return
      }
      try {
        const agg = await influx.tripAggregate(t.start_time, t.stop_time)
        if (db && agg.maxStw != null) {
          db.setMaxStw(t.id, agg.maxStw)
        }
        ok++
      } catch (e) {
        failed++
        app.debug(`max_stw backfill failed for trip ${t.id}: ${e.message}`)
      }
    }
    if (!db) {
      return
    }
    // Don't burn the one-shot guard on a transient InfluxDB outage: only defer
    // when there were trips but *every* query threw (Influx unreachable), so a
    // later restart retries. Any run with at least one success — or with no
    // failures at all, including genuinely dataless trips whose query returns
    // null without throwing — counts as complete and bumps the guard. (A partial
    // outage that clears mid-run leaves a few old trips without a peak; that's
    // cosmetic and not worth re-running the whole backfill for.)
    if (trips.length && !ok && failed) {
      app.debug('max_stw backfill deferred: InfluxDB unreachable, will retry')
      return
    }
    db.setUserVersion(3)
    app.debug(`max_stw backfill done (${ok} of ${trips.length} trips)`)
  }

  // One-time re-classification of engine_share for every complete trip, using the
  // corrected engineStateSeries seeding (a valid but old 'stopped' seed is no
  // longer discarded, so a single mid-trip 'started' is no longer back-projected
  // across a whole sail). Fixes trips completed under the old logic, e.g. the
  // Flakfortet→Rungsted sail that read as 100 % motoring. Guarded by user_version
  // so it runs once; runs in the background — start() must not block on it.
  async function backfillEngineShareOnce () {
    if (db.userVersion() >= 4) {
      return
    }
    const trips = db.completeTripWindows()
    if (!trips.length) {
      db.setUserVersion(4)
      return
    }
    // engineStateSeries swallows a query failure as "no data", so it can't tell a
    // real dataless trip from an InfluxDB outage. Probe once with a query that
    // does throw, so an outage defers the whole backfill instead of nulling every
    // trip's share and burning the guard.
    try {
      await influx.tripAggregate(trips[0].start_time, trips[0].stop_time)
    } catch (e) {
      app.debug('engine_share backfill deferred: InfluxDB unreachable, will retry')
      return
    }
    for (const t of trips) {
      if (!db) {
        return
      }
      const engine = await analyzeTripEngine(t.start_time, t.stop_time)
      // Only write a real share, matching the live paths. analyzeTripEngine
      // swallows a query error as share=null, so without this guard a mid-run
      // InfluxDB hiccup (after the probe passed) would null out later trips'
      // shares and then burn the guard. A null result is a genuinely dataless
      // window, which was already null, so skipping it never drops a correction.
      if (db && engine.share != null) {
        db.setEngineShare(t.id, engine.share)
      }
    }
    if (!db) {
      return
    }
    // The hourly cache carries per-hour motor badges derived from engine state;
    // drop it so it re-annotates with the recomputed state on next view.
    db.clearHourlyCache()
    db.setUserVersion(4)
    app.debug(`engine_share backfill done (${trips.length} trips)`)
  }

  // A maneuver is an "edge" maneuver (harbour departure/arrival, to be ignored)
  // if it is close in time OR in distance to the trip start or end. The end
  // checks are null-safe so this also works on a still-active trip (start only).
  function isEdgeManeuver (trip, time, lat, lon) {
    const m = edgeMarginMs()
    const r = edgeRadiusM()
    if (time - trip.start_time < m) {
      return true
    }
    if (trip.stop_time != null && trip.stop_time - time < m) {
      return true
    }
    if (lat != null && lon != null) {
      if (trip.start_lat != null && haversine(lat, lon, trip.start_lat, trip.start_lon) < r) {
        return true
      }
      if (trip.stop_lat != null && haversine(lat, lon, trip.stop_lat, trip.stop_lon) < r) {
        return true
      }
    }
    return false
  }

  function onManeuver (m) {
    if (currentTripId == null) {
      return
    }
    if (m.newTackAngle == null && !unjudgedManeuverSeen) {
      unjudgedManeuverSeen = true
      app.debug(
        'no apparent wind angle available; the new-tack requirement is inactive ' +
        'and maneuvers are counted on the side change alone')
    }
    const trip = db.getTrip(currentTripId)
    const pos = positionNow() || {}
    // Drop maneuvers near the trip start (harbour departure). The end edge is
    // enforced when the trip completes, since the end is not known yet.
    if (trip && isEdgeManeuver(trip, m.time, pos.lat, pos.lon)) {
      return
    }
    // Drop maneuvers made under engine as they happen, so the live log isn't
    // filled with motoring turns during the trip (previously only cleaned up at
    // completion). Completion still reconciles against the recorded state.
    if (engineOnAt(m.time)) {
      app.debug(`maneuver at ${new Date(m.time).toISOString()} ignored: engine on`)
      return
    }
    db.addEvent({
      tripId: currentTripId,
      time: m.time,
      type: m.type,
      twaBefore: m.twaBefore,
      twaAfter: m.twaAfter,
      lat: pos.lat,
      lon: pos.lon
    })
  }

  // ---- retrospective scan --------------------------------------------------

  // How much of the history one scan query covers. Three days keeps a single
  // response in the low tens of thousands of buckets at the 15 s position step.
  const SCAN_CHUNK_MS = 3 * 24 * 3600 * 1000
  // Fine enough for the detector's trail: it wants five fixes inside the start
  // window and calls a two-minute hole a gap.
  const SCAN_FIX_STEP_SEC = 15

  // The grid both scan series share, so a chunk boundary never splits a bucket.
  function lcm (a, b) {
    let x = a
    let y = b
  // Work is O(window), one query pair per chunk: cap it against a mistyped year.
  const SCAN_MAX_RANGE_DAYS = 730
  const SCAN_MAX_RANGE_MS = SCAN_MAX_RANGE_DAYS * 24 * 3600 * 1000
    while (y) {
      [x, y] = [y, x % y]
    }
    return (a / x) * b
  }

  async function scan (fromMs, toMs, stepSec) {
    const detector = createTripDetector(detectorOpts())
    const pending = []
    let open = null
    let scanned = 0
    const onStart = (startedAt) => {
      open = { start: startedAt }
    }
    const onStop = (stoppedAt) => {
      if (open) {
    let segments = 0
    const created = []
        open.stop = stoppedAt
        pending.push(open)
        segments += 1
        open = null
      }
    }
    // Written per chunk, not after the walk: a late failure keeps what scanned.
    const writeFound = async () => {
      while (pending.length) {
        const seg = pending.shift()
        if (db.findOverlapping(seg.start, seg.stop)) {
          continue
        }
        created.push(await createRetroTrip(seg.start, seg.stop))
      }
    }
    // One chunk's two series, one retry.
    const readChunk = async (chunkFrom, chunkTo) => {
      const read = () => Promise.all([
        influx.sogSeries(chunkFrom, chunkTo, sogStep),
        // Detector reads the trail too; fixes replay interleaved, in time order.
        influx.positionSeries(chunkFrom, chunkTo, SCAN_FIX_STEP_SEC)
      ])
      try {
        return await read()
      } catch (e) {
        // 4xx (auth, unknown database) cannot succeed on a retry.
        if (/HTTP 4\d\d/.test(e.message)) {
          throw e
        }
        app.debug(`scan chunk ${chunkFrom}-${chunkTo} failed (${e.message}); retrying`)
        return read()
      }
    }
    // Chunked: a season at 15 s is >500k buckets in one response. Detector state
    // and trail survive a boundary, and chunks are contiguous, so the segments
    // match an unchunked pass.
    const sogStep = stepSec || 30
    // GROUP BY time() buckets against the epoch, not against the window, so a
    // boundary inside a bucket would return that bucket to both chunks, each
    // time over half its samples. Cutting on the grid both series share leaves
    // every bucket whole and in exactly one chunk.
    const gridMs = lcm(sogStep * 1000, SCAN_FIX_STEP_SEC * 1000)
    for (let chunkFrom = fromMs; chunkFrom <= toMs;) {
      const nextGrid = Math.ceil((chunkFrom + SCAN_CHUNK_MS) / gridMs) * gridMs
      // Both window bounds are inclusive, so a chunk ends the millisecond
    let incompleteFrom = null
    let failure = null
      // before the bucket that opens the next one.
      const chunkTo = Math.min(nextGrid - 1, toMs)
      let samples
      let fixes
      try {
        [samples, fixes] = await readChunk(chunkFrom, chunkTo)
      } catch (e) {
        // Resume point, reported to the caller. An open trip dies with the
        // detector, so it is that trip's start: resuming at the chunk would
        // record it from the boundary instead.
        incompleteFrom = open ? open.start : chunkFrom
        failure = e
        break
      }
      let next = 0
      const feedFixesUpTo = (t) => {
        while (next < fixes.length && (t == null || fixes[next][0] <= t)) {
          detector.feedPosition(fixes[next][0], fixes[next][1], fixes[next][2])
          next += 1
        }
      }
      samples.forEach(([t, sog]) => {
        feedFixesUpTo(t)
        detector.feed(t, sog, onStart, onStop)
      })
      // The fixes past the chunk's last speed sample are the trail an unchunked
      // pass would have fed before the next chunk's first sample. Leaving them
      // behind would open a hole at every boundary.
      feedFixesUpTo(null)
      scanned += samples.length
      chunkFrom = chunkTo + 1
      await writeFound()
    }

    await writeFound()
    const result = { scanned, segments, created: created.length }
    if (incompleteFrom != null) {
      app.error(`scan stopped at ${new Date(incompleteFrom).toISOString()}: ${failure.message}`)
      result.incompleteFrom = incompleteFrom
      result.error = failure.message
    }
    return result
  }

  async function createRetroTrip (startMs, stopMs) {
    let distanceNm = null
    let maxStw = null
    let bounds = { start: {}, stop: {} }
    try {
      const agg = await influx.tripAggregate(startMs, stopMs)
      if (agg.meanSog != null) {
        distanceNm = (agg.meanSog * (stopMs - startMs)) / 1000 / NM
      }
      maxStw = agg.maxStw
      bounds = await influx.positionBounds(startMs, stopMs)
    } catch (e) {
      app.error(`retro aggregate failed: ${e.message}`)
    }
    const tripId = db.createCompleteTrip({
      startTime: startMs,
      stopTime: stopMs,
      startLat: bounds.start.lat,
      startLon: bounds.start.lon,
      stopLat: bounds.stop.lat,
      stopLon: bounds.stop.lon,
      distanceNm,
      maxStw,
      origin: 'retro'
    })

    // Engine-on analysis for maneuver gating and the motoring share.
    const engine = await analyzeTripEngine(startMs, stopMs)
    if (engine.share != null) {
      db.setEngineShare(tripId, engine.share)
    }

    // Reconstruct maneuvers from the TWA history for this trip, gated by the STW
    // history on the same grid, by proximity (time and distance) to the ends,
    // and by whether the engine was running.
    try {
      // Prefer true wind angle; fall back to apparent when the true-wind
      // derivation logged nothing for this stretch (e.g. a multi-day gap). AWA
      // also flips side on a tack/gybe, so sign-crossing detection still works,
      // just a bit coarser.
      // Sampled at 1 s, the rate the live path sees, so the detector's own
      // smoothing window spans the same number of samples either way.
      let angles = await influx.twaSeries(startMs, stopMs, 1)
      let angleSource = 'twa'
      // Apparent wind on the same grid: the new-tack requirement is judged
      // against it, whether or not it is also standing in for the true angle.
      const apparent = await influx.awaSeries(startMs, stopMs, 1)
      if (!angles.length) {
        angles = apparent
        angleSource = 'awa'
      }
      if (!apparent.length) {
        app.debug(
          `retro trip ${tripId}: no apparent wind in window; the new-tack ` +
          'requirement is inactive for it')
      }
      const stw = await influx.stwSeries(startMs, stopMs, 1)
      // The gate's fallback needs speed over ground on the same grid, for a
      // window where the log was fouled or silent (see gateSpeed).
      const sog = await influx.sogSeries(startMs, stopMs, 1)
      const positions = await influx.positionSeries(startMs, stopMs, 15)
      const stwAt = new Map(stw)
      const sogAt = new Map(sog)
      const retroTrip = {
        start_time: startMs,
        stop_time: stopMs,
        start_lat: bounds.start.lat,
        start_lon: bounds.start.lon,
        stop_lat: bounds.stop.lat,
        stop_lon: bounds.stop.lon
      }
      const nearestPos = (t) => {
        let best = null
        let bd = Infinity
        for (const [pt, la, lo] of positions) {
          const d = Math.abs(pt - t)
          if (d < bd) {
            bd = d
            best = { lat: la, lon: lo }
          }
        }
        return best || {}
      }
      const md = createManeuverDetector(detectorOpts())
      // Its own gate, replaying this window's zero runs from the start rather
      // than inheriting whatever state the live one is in.
      const sg = createSpeedGate()
      // Apparent wind on its own timeline, interleaved rather than sampled at
      // the true-wind grid: where the true series has a hole, the apparent one
      // still reaches the detector, as it would live.
      let nextAwa = 0
      angles.forEach(([t, angle]) => {
        while (nextAwa < apparent.length && apparent[nextAwa][0] <= t) {
          md.feedApparent(apparent[nextAwa][0], apparent[nextAwa][1])
          nextAwa += 1
        }
        const stwHere = stwAt.has(t) ? stwAt.get(t) : null
        const speed = sg.speedAt(t, stwHere, sogAt.has(t) ? sogAt.get(t) : null)
        md.feed(t, angle, speed, (m) => {
          const pos = nearestPos(m.time)
          if (isEdgeManeuver(retroTrip, m.time, pos.lat, pos.lon) || engine.onAt(m.time)) {
            return
          }
          db.addEvent({
            tripId,
            time: m.time,
            type: m.type,
            twaBefore: m.twaBefore,
            twaAfter: m.twaAfter,
            lat: pos.lat,
            lon: pos.lon
          })
        })
      })
      if (angleSource === 'awa') {
        app.debug(`retro trip ${tripId}: no TWA in window, used AWA fallback for maneuvers`)
      }
    } catch (e) {
      app.error(`retro maneuvers failed: ${e.message}`)
    }

    geocodeTrip(tripId, 'start', bounds.start.lat, bounds.start.lon)
    geocodeTrip(tripId, 'stop', bounds.stop.lat, bounds.stop.lon)
    return tripId
  }

  // The live gate, with a one-off note in the log so a passage gated on speed
  // over ground says so rather than looking like an ordinary quiet day.
  function gatedSpeed (timeMs, stw, sog) {
    const speed = speedGate ? speedGate.speedAt(timeMs, stw, sog) : stw
    if (speed !== stw && !fouledLogSeen) {
      fouledLogSeen = true
      app.debug(
        `speed through water unusable for the maneuver gate (STW ` +
        `${stw == null ? 'missing' : stw.toFixed(2)} m/s vs SOG ${sog.toFixed(2)} m/s); ` +
        'gating on speed over ground instead')
    }
    return speed
  }

  function detectorOpts () {
    return {
      startKnots: options.startKnots,
      stopKnots: options.stopKnots,
      startMinSeconds: options.startMinSeconds,
      stopMinSeconds: options.stopMinSeconds,
      stopSpreadMeters: options.stopSpreadMeters,
      minTackSeconds: options.minNewTackSeconds != null ? options.minNewTackSeconds : 90,
      runDeadbandDeg: options.runDeadbandDeg != null ? options.runDeadbandDeg : 10,
      newTackMinAwaDeg: options.newTackMinAwaDeg != null ? options.newTackMinAwaDeg : 20,
      smoothSeconds: options.twaSmoothingSeconds != null ? options.twaSmoothingSeconds : 10,
      minSpeed: (options.minSailingSpeedKnots != null ? options.minSailingSpeedKnots : 2) * KNOT
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  plugin.start = function (opts) {
    options = Object.assign(
      {
        dbPath: '',
        startKnots: 0.5,
        stopKnots: 0.3,
        startMinSeconds: 180,
        stopMinSeconds: 600,
        stopSpreadMeters: 50,
        minNewTackSeconds: 90,
        runDeadbandDeg: 10,
        newTackMinAwaDeg: 20,
        twaSmoothingSeconds: 10,
        minSailingSpeedKnots: 2,
        maneuverEdgeMarginMinutes: 5,
        maneuverEdgeRadiusMeters: 200,
        engineAware: true,
        engineStatePath: 'propulsion.0.state',
        motorTripPercent: 85,
        geocode: true,
        placeRadiusMeters: 250,
        influxHost: 'localhost',
        influxPort: 8086,
        database: 'libelle',
        username: '',
        password: ''
      },
      opts || {}
    )
    geocodeEnabled = options.geocode !== false

    // Default to the plugin's own data directory when unset, rather than any
    // one boat's storage layout.
    db = dbLib.open(options.dbPath || path.join(app.getDataDirPath(), 'logbook.sqlite'))
    // Migrate pre-registry manual place names into the shared places table once.
    seedPlacesOnce()
    influx = influxLib.makeInflux({
      host: options.influxHost,
      port: options.influxPort,
      database: options.database,
      username: options.username,
      password: options.password,
      paths: { engineState: options.engineStatePath || 'propulsion.0.state' }
    })

    // Backfill max_stw then re-classify engine_share for pre-existing trips
    // (background, never blocks start). Chained so they don't race on user_version.
    backfillMaxStwOnce()
      .then(() => backfillEngineShareOnce())
      .catch((e) => app.debug(`backfill error: ${e.message}`))

    // Resume an open trip left behind by a restart.
    const active = db.getActiveTrip()
    currentTripId = active ? active.id : null

    tripDetector = createTripDetector(
      Object.assign(detectorOpts(), { initialMoving: !!active })
    )
    maneuverDetector = createManeuverDetector(detectorOpts())
    speedGate = createSpeedGate()
    seedEngineState()

    const engineStatePath = options.engineStatePath || 'propulsion.0.state'
    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: [
          { path: 'navigation.speedOverGround', period: 1000 },
          { path: 'navigation.speedThroughWater', period: 1000 },
          { path: 'environment.wind.angleTrueWater', period: 1000 },
          { path: 'environment.wind.angleApparent', period: 1000 },
          { path: 'navigation.position', period: 5000 },
          { path: engineStatePath, period: 1000 }
        ]
      },
      unsubscribes,
      (err) => app.error('subscription error: ' + err),
      (delta) => {
        const now = Date.now()
        ;(delta.updates || []).forEach((u) => {
          ;(u.values || []).forEach((v) => {
            if (v.path === 'navigation.speedOverGround' && typeof v.value === 'number') {
              lastSOG = v.value
              feedSog(now, v.value)
            } else if (v.path === 'navigation.speedThroughWater' && typeof v.value === 'number') {
              lastSTW = v.value
            } else if (v.path === 'environment.wind.angleApparent' && typeof v.value === 'number') {
              // Judged against, not detected from: the side still comes from true
              // wind. See the new-tack requirement in detector.js.
              maneuverDetector.feedApparent(now, v.value)
            } else if (v.path === 'environment.wind.angleTrueWater' && typeof v.value === 'number') {
              maneuverDetector.feed(now, v.value, gatedSpeed(now, lastSTW, lastSOG), onManeuver)
            } else if (v.path === 'navigation.position' && v.value && typeof v.value.latitude === 'number') {
              lastPosition = { lat: v.value.latitude, lon: v.value.longitude }
              tripDetector.feedPosition(now, lastPosition.lat, lastPosition.lon)
              positionTrail.push([now, lastPosition.lat, lastPosition.lon])
              while (positionTrail.length && now - positionTrail[0][0] > trailWindowMs()) {
                positionTrail.shift()
              }
            } else if (v.path === engineStatePath) {
              onEngineState(v.value, now)
            }
          })
        })
      }
    )

    app.setPluginStatus(
      active ? `Resumed active trip #${active.id}` : 'Watching for trips'
    )
  }

  plugin.stop = function () {
    unsubscribes.forEach((f) => {
      try {
        f()
      } catch (e) {
        // ignore
      }
    })
    unsubscribes = []
    // Do NOT close an active trip here: a plugin restart must not end a sail.
    if (db) {
      db.close()
      db = null
    }
    tripDetector = null
    maneuverDetector = null
    // Drop cached live samples so a restart doesn't seed a new trip with a stale
    // position or speed before fresh deltas arrive.
    lastPosition = null
    positionTrail = []
    lastSTW = null
    lastSOG = null
    speedGate = null
    fouledLogSeen = false
    liveEngineState = null
    liveEngineOnSince = null
    // Discard the partial SOG bucket; the mean must not straddle a restart.
    sogBucketStart = null
    sogBucketSum = 0
    sogBucketCount = 0
  }

  // ---- HTTP: read via signalKApiRoutes, writes/scan via registerWithRouter --

  function tripDetail (id) {
    const trip = db.getTrip(id)
    if (!trip) {
      return null
    }
    const events = db.getEvents(id)
    return { trip: withPlaces(trip), events }
  }

  // Compute a trip's hourly stats from InfluxDB, annotated with per-hour engine
  // state. Empty for an active trip (window still growing), an error, or no data.
  async function computeHourly (trip) {
    if (!trip.stop_time) {
      return []
    }
    try {
      const hourly = await influx.hourlyStats(trip.start_time, trip.stop_time)
      await annotateHourlyEngine(hourly, trip.start_time, trip.stop_time)
      return hourly
    } catch (e) {
      app.error(`hourlyStats failed: ${e.message}`)
      return []
    }
  }

  // Hourly stats with a persistent cache. A completed trip's window is in the
  // past, so its stats never change: compute once, store the JSON on the trip row
  // and read it back on every later detail/report load — no InfluxDB round-trip,
  // and it survives a restart (unlike an in-memory cache). `trip` must be the raw
  // row (carries hourly_json + stop_time), not the place-overlaid view.
  async function hourlyFor (trip) {
    if (!trip.stop_time) {
      return computeHourly(trip)
    }
    if (trip.hourly_json) {
      try {
        return JSON.parse(trip.hourly_json)
      } catch (e) {
        // Corrupt cache: fall through and recompute.
      }
    }
    const hourly = await computeHourly(trip)
    // Only cache a real result — an empty array may be a transient InfluxDB error,
    // not a genuinely dataless trip, and must not be frozen in.
    if (db && hourly.length) {
      db.setHourlyJson(trip.id, JSON.stringify(hourly))
    }
    return hourly
  }

  // Mark each hourly bucket that was mostly under engine, so the report and
  // webapp can show a motor badge instead of pointing angles for that hour.
  async function annotateHourlyEngine (hourly, startMs, stopMs) {
    if (options.engineAware === false || !hourly || !hourly.length) {
      return
    }
    const eng = fromStateSeries(await influx.engineStateSeries(startMs, stopMs))
    if (!eng) {
      return
    }
    const HOUR = 3600000
    hourly.forEach((h) => {
      const from = Math.max(h.time, startMs)
      const to = Math.min(h.time + HOUR, stopMs)
      const frac = eng.fraction(from, to)
      if (frac != null) {
        h.engineFraction = frac
        h.motor = frac >= 0.5
      }
    })
  }

  // A trip counts as a motoring trip when the engine share meets the threshold.
  function motorTrip (trip) {
    const pct = options.motorTripPercent != null ? options.motorTripPercent : 85
    return trip.engine_share != null && trip.engine_share * 100 >= pct
  }

  // Guard route handlers that run after the plugin may have stopped (db closed).
  function dbGone (res) {
    if (!db) {
      res.status(503).json({ error: 'plugin stopped' })
      return true
    }
    return false
  }
  function listHandler (req, res) {
    if (dbGone(res)) {
      return
    }
    const trips = db.listTrips().map((t) =>
      Object.assign(withPlaces(t), db.countEvents(t.id), { motor: motorTrip(t) })
    )
    res.json(trips)
  }
  // Parse a numeric :id route param, or null if it isn't a positive integer.
  // Strict: "5abc" is rejected, not silently read as 5.
  function tripIdParam (req) {
    if (!/^\d+$/.test(req.params.id)) {
      return null
    }
    const id = parseInt(req.params.id, 10)
    return Number.isInteger(id) && id > 0 ? id : null
  }
  // The trip row and its maneuvers, straight from SQLite — no InfluxDB, so it
  // returns in milliseconds. The expensive hourly stats load separately (see
  // hourlyHandler), letting the webapp render the header and map immediately.
  function detailHandler (req, res) {
    const id = tripIdParam(req)
    if (id == null) {
      return res.status(400).json({ error: 'invalid id' })
    }
    if (dbGone(res)) {
      return
    }
    const base = tripDetail(id)
    if (!base) {
      return res.status(404).json({ error: 'not found' })
    }
    res.json({
      trip: Object.assign({}, base.trip, { motor: motorTrip(base.trip) }),
      events: base.events
    })
  }
  // The trip's hourly statistics, the expensive part of the detail. Served on its
  // own so the rest of the view isn't held up by it, and cached per completed trip.
  async function hourlyHandler (req, res) {
    const id = tripIdParam(req)
    if (id == null) {
      return res.status(400).json({ error: 'invalid id' })
    }
    if (dbGone(res)) {
      return
    }
    const trip = db.getTrip(id)
    if (!trip) {
      return res.status(404).json({ error: 'not found' })
    }
    try {
      res.json({ hourly: await hourlyFor(trip) })
    } catch (e) {
      app.error(`hourly failed: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  }
  // Downsampled position+SOG track for the map plot. Points are capped by
  // choosing a time step from the trip length, so a long passage stays a few
  // hundred points rather than tens of thousands. Nothing is persisted; the
  // track is derived from InfluxDB on demand like the hourly stats.
  async function trackHandler (req, res) {
    const id = tripIdParam(req)
    if (id == null) {
      return res.status(400).json({ error: 'invalid id' })
    }
    if (dbGone(res)) {
      return
    }
    const trip = db.getTrip(id)
    if (!trip) {
      return res.status(404).json({ error: 'not found' })
    }
    const stopMs = trip.stop_time || Date.now()
    if (!trip.start_time || stopMs <= trip.start_time) {
      return res.json({ points: [], reason: 'no-window' })
    }
    // Aim for ~600 points; never finer than 5 s.
    const stepSec = Math.max(5, Math.round((stopMs - trip.start_time) / 1000 / 600))
    try {
      const points = await influx.trackSeries(trip.start_time, stopMs, stepSec)
      // Too little to draw a line: say which case it is, so the webapp can tell
      // the reader whether there is a setting to change or simply no track. A
      // single point is its own answer — the trip did log a position, so asking
      // the database whether any exists would be both wasteful and wrong.
      if (points.length === 1) {
        return res.json({ points: [], reason: 'too-few-positions' })
      }
      if (!points.length) {
        const reason = (await influx.hasPositionHistory())
          ? 'no-position-in-trip'
          : 'no-position-logged'
        return res.json({ points: [], reason })
      }
      // Flag each point that fell under engine, so the map's info panel can badge
      // it (same engine-state source as the hourly table and maneuver gating).
      const engine = await analyzeTripEngine(trip.start_time, stopMs)
      points.forEach((p) => {
        p.motor = engine.onAt(p.t)
      })
      res.json({ points })
    } catch (e) {
      app.error(`track failed: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  }
  // Raw-ish channel history over a window inside the trip, for the detail
  // graphs. Deliberately generic (and uncached): the caller names the span, the
  // channels and how fine a grid it wants, so the same route serves any
  // zoomed-in view of a trip — first user is the per-hour graph under the
  // weather table. The span is clamped to the trip and the grid to a point
  // budget, so no query can be widened into a scan of the whole database.
  const SERIES_FIELDS = ['sog', 'stw', 'tws', 'twd', 'twa', 'awa', 'heel']
  const SERIES_MAX_POINTS = 1500
  const SERIES_MIN_STEP_SEC = 5
  async function seriesHandler (req, res) {
    const id = tripIdParam(req)
    if (id == null) {
      return res.status(400).json({ error: 'invalid id' })
    }
    if (dbGone(res)) {
      return
    }
    const trip = db.getTrip(id)
    if (!trip) {
      return res.status(404).json({ error: 'not found' })
    }
    // Express parses ?fields[toString]=x into an object, and coercing one of
    // those throws — outside the try below, that would be an unhandled rejection
    // with the request left hanging. Only a plain string is a value here; an
    // empty one means the parameter was not given.
    const asText = (v) => (typeof v === 'string' ? v.trim() : '')
    // Deduplicated: a repeated channel is one query per repetition, and each is
    // a full scan of the window.
    const fields = Array.from(new Set(asText(req.query.fields).split(',')
      .map((f) => f.trim())
      .filter((f) => SERIES_FIELDS.includes(f))))
    if (!fields.length) {
      return res.status(400).json({ error: `fields must name at least one of ${SERIES_FIELDS.join(',')}` })
    }
    const tripStop = trip.stop_time || Date.now()
    const asInt = (v, fallback) => {
      const text = asText(v)
      if (!text) {
        return fallback
      }
      const num = Number(text)
      return Number.isFinite(num) ? Math.trunc(num) : fallback
    }
    const from = Math.max(trip.start_time, asInt(req.query.from, trip.start_time))
    const to = Math.min(tripStop, asInt(req.query.to, tripStop))
    if (!(to > from)) {
      return res.json({ from, to, step: SERIES_MIN_STEP_SEC, points: [] })
    }
    // Never finer than the minimum step, and coarser still for a long window so
    // the response stays within the point budget. A caller may ask for a coarser
    // grid than that (a graph gains nothing from several samples per pixel) but
    // not for a finer one.
    const budgetStep = Math.max(
      SERIES_MIN_STEP_SEC,
      Math.ceil((to - from) / 1000 / SERIES_MAX_POINTS)
    )
    const step = Math.max(budgetStep, asInt(req.query.step, budgetStep))
    try {
      res.json({ from, to, step, points: await influx.channelSeries(from, to, step, fields) })
    } catch (e) {
      app.error(`series failed: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  }
  async function reportHandler (req, res) {
    const id = tripIdParam(req)
    if (id == null) {
      return res.status(400).send('invalid id')
    }
    if (dbGone(res)) {
      return
    }
    const base = tripDetail(id)
    if (!base) {
      return res.status(404).send('not found')
    }
    try {
      // hourlyFor needs the raw row (hourly_json); base.trip is the stripped view.
      const hourly = await hourlyFor(db.getTrip(id))
      const requested = typeof req.query.lang === 'string' ? req.query.lang : ''
      const lang = report.languages.includes(requested) ? requested : 'en'
      const motor = motorTrip(base.trip)
      res.type('text/plain; charset=utf-8').send(report.buildReport(base.trip, base.events, hourly, lang, motor))
    } catch (e) {
      app.error(`report failed: ${e.message}`)
      res.status(500).send(e.message)
    }
  }

  // Read-only routes, namespaced and mounted under /signalk/v1/api so the
  // server's "allow readonly access" setting lets the webapp read them without
  // admin auth (same trick as signalk-humidity-history).
  plugin.signalKApiRoutes = function (router) {
    router.get('/sailing-logbook/trips', listHandler)
    router.get('/sailing-logbook/trips/:id', detailHandler)
    router.get('/sailing-logbook/trips/:id/hourly', hourlyHandler)
    router.get('/sailing-logbook/trips/:id/report', reportHandler)
    router.get('/sailing-logbook/trips/:id/track', trackHandler)
    router.get('/sailing-logbook/trips/:id/series', seriesHandler)
    return router
  }

  // Everything under /plugins/<id> is admin-guarded by the server. The webapp
  // uses these for edits and the retro scan; reading also works here for admins.
  plugin.registerWithRouter = function (router) {
    router.get('/trips', listHandler)
    router.get('/trips/:id', detailHandler)
    router.get('/trips/:id/hourly', hourlyHandler)
    router.get('/trips/:id/report', reportHandler)
    router.get('/trips/:id/track', trackHandler)
    router.get('/trips/:id/series', seriesHandler)

    // Save a place name (create or rename), anchored at the trip's start/stop and
    // shared with every trip near it. Never deletes; clearing a field is a no-op,
    // deletion is the explicit DELETE route below.
    router.put('/trips/:id/place', (req, res) => {
      const id = tripIdParam(req)
      if (id == null) {
        return res.status(400).json({ error: 'invalid id' })
      }
      const body = req.body || {}
      if (
        (body.startPlace != null && typeof body.startPlace !== 'string') ||
        (body.stopPlace != null && typeof body.stopPlace !== 'string')
      ) {
        return res.status(400).json({ error: 'startPlace/stopPlace must be strings' })
      }
      if (dbGone(res)) {
        return
      }
      const trip = db.getTrip(id)
      if (!trip) {
        return res.status(404).json({ error: 'not found' })
      }
      if (body.startPlace !== undefined) {
        applyPlaceEdit(trip.start_lat, trip.start_lon, trip.start_place, body.startPlace)
      }
      if (body.stopPlace !== undefined) {
        applyPlaceEdit(trip.stop_lat, trip.stop_lon, trip.stop_place, body.stopPlace)
      }
      res.json(withPlaces(db.getTrip(id)))
    })

    // Explicitly remove the named place at a trip's start or stop, reverting every
    // trip near it to its geocoded name. :side is 'start' or 'stop'.
    router.delete('/trips/:id/place/:side', (req, res) => {
      const id = tripIdParam(req)
      if (id == null) {
        return res.status(400).json({ error: 'invalid id' })
      }
      const side = req.params.side
      if (side !== 'start' && side !== 'stop') {
        return res.status(400).json({ error: 'side must be start or stop' })
      }
      if (dbGone(res)) {
        return
      }
      const trip = db.getTrip(id)
      if (!trip) {
        return res.status(404).json({ error: 'not found' })
      }
      deletePlaceAt(trip[`${side}_lat`], trip[`${side}_lon`])
      res.json(withPlaces(db.getTrip(id)))
    })

    // Save (or clear) the skipper's free-text notes for a trip. An empty or
    // whitespace-only body clears them (stored as NULL).
    router.put('/trips/:id/notes', (req, res) => {
      const id = tripIdParam(req)
      if (id == null) {
        return res.status(400).json({ error: 'invalid id' })
      }
      const body = req.body || {}
      if (body.notes != null && typeof body.notes !== 'string') {
        return res.status(400).json({ error: 'notes must be a string' })
      }
      if (dbGone(res)) {
        return
      }
      const trip = db.getTrip(id)
      if (!trip) {
        return res.status(404).json({ error: 'not found' })
      }
      const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null
      db.setNotes(id, notes)
      res.json(withPlaces(db.getTrip(id)))
    })

    router.delete('/trips/:id', (req, res) => {
      const id = tripIdParam(req)
      if (id == null) {
        return res.status(400).json({ error: 'invalid id' })
      }
      if (dbGone(res)) {
        return
      }
      db.deleteTrip(id)
      res.json({ ok: true })
    })

    // Manually remove a single maneuver (e.g. a false tack from a motoring leg).
    router.delete('/events/:id', (req, res) => {
      const id = tripIdParam(req)
      if (id == null) {
        return res.status(400).json({ error: 'invalid id' })
      }
      if (dbGone(res)) {
        return
      }
      db.deleteEvent(id)
      res.json({ ok: true })
    })

    router.post('/scan', async (req, res) => {
      const body = req.body || {}
      const from = parseInt(body.from, 10)
      const to = parseInt(body.to, 10)
      if (!from || !to || to <= from) {
        return res.status(400).json({ error: 'from/to (ms epoch) required, to > from' })
      }
      let stepSec
      if (body.stepSec != null) {
        stepSec = parseInt(body.stepSec, 10)
        if (!Number.isInteger(stepSec) || stepSec <= 0) {
          return res.status(400).json({ error: 'stepSec must be a positive integer' })
        }
      }
      try {
        const result = await scan(from, to, stepSec)
      // See SCAN_MAX_RANGE_DAYS.
      if (to - from > SCAN_MAX_RANGE_MS) {
        return res.status(400).json({
          error: `range must be at most ${SCAN_MAX_RANGE_DAYS} days; scan a season at a time`
        })
      }
        res.json(result)
      } catch (e) {
        app.error(`scan failed: ${e.message}`)
        res.status(500).json({ error: e.message })
      }
    })
  }

  plugin.getOpenApi = () => ({
    openapi: '3.0.0',
    info: { title: 'Sailing Logbook API', version: '0.1.0' },
    paths: {
      '/trips': { get: { summary: 'List trips', responses: { 200: { description: 'ok' } } } },
      '/trips/{id}': { get: { summary: 'Trip detail with hourly stats', responses: { 200: { description: 'ok' } } } },
      '/scan': {
        post: {
          summary: 'Retrospectively detect trips from InfluxDB',
          responses: {
            200: { description: 'ok; incompleteFrom set when the scan stopped early' },
            400: { description: `from/to missing, to <= from, or a range over ${SCAN_MAX_RANGE_DAYS} days` }
          }
        }
      }
    }
  })

  return plugin
}
