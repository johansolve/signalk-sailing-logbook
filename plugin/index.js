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

const dbLib = require('./lib/db')
const influxLib = require('./lib/influx')
const geocode = require('./lib/geocode')
const report = require('./lib/report')
const { createTripDetector, createManeuverDetector, KNOT } = require('./lib/detector')
const { analyzeEngine } = require('./lib/engine')

const NM = 1852 // metres per nautical mile

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
  let lastSTW = null // most recent speed through water (m/s), for the maneuver gate
  let geocodeEnabled = true

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
        default: '/storage/sailing-logbook/logbook.sqlite'
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
        title: 'Use alternator temperature and charge current to detect engine-on periods (ignore maneuvers made under engine, flag motoring trips)',
        default: true
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

  function geocodeTrip (tripId, which, lat, lon) {
    if (!geocodeEnabled || lat == null || lon == null) {
      return
    }
    geocode
      .reverse(lat, lon)
      .then((name) => {
        if (name) {
          db.setGeocode(tripId, which === 'start' ? { startPlace: name } : { stopPlace: name })
        }
      })
      .catch((e) => app.debug(`geocode failed: ${e.message}`))
  }

  function onTripStart (startedAt) {
    const pos = positionNow() || {}
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
    const pos = positionNow() || {}
    completeTripAsync(tripId, trip.start_time, stoppedAt, pos)
    app.setPluginStatus(`Trip ended ${new Date(stoppedAt).toISOString()}`)
  }

  async function completeTripAsync (tripId, startMs, stopMs, stopPos) {
    let distanceNm = null
    let maxSog = null
    try {
      const agg = await influx.tripAggregate(startMs, stopMs)
      if (agg.meanSog != null) {
        distanceNm = (agg.meanSog * (stopMs - startMs)) / 1000 / NM
      }
      maxSog = agg.maxSog
    } catch (e) {
      app.error(`trip aggregate failed: ${e.message}`)
    }
    db.completeTrip(tripId, {
      stopTime: stopMs,
      stopLat: stopPos.lat,
      stopLon: stopPos.lon,
      distanceNm,
      maxSog
    })
    // Now that the end is known, drop maneuvers near it in time or distance
    // (dropping sails, mooring turns) or while the engine was running, and
    // record how much of the trip was under engine.
    const completed = db.getTrip(tripId)
    const engine = await analyzeTripEngine(startMs, stopMs)
    db.getEvents(tripId).forEach((e) => {
      if (isEdgeManeuver(completed, e.time, e.lat, e.lon) || engine.onAt(e.time)) {
        db.deleteEvent(e.id)
      }
    })
    if (engine.share != null) {
      db.setEngineShare(tripId, engine.share)
    }
    geocodeTrip(tripId, 'stop', stopPos.lat, stopPos.lon)
  }

  function edgeMarginMs () {
    return (options.maneuverEdgeMarginMinutes != null ? options.maneuverEdgeMarginMinutes : 5) * 60000
  }
  function edgeRadiusM () {
    return options.maneuverEdgeRadiusMeters != null ? options.maneuverEdgeRadiusMeters : 200
  }

  // Engine-on analysis over a trip window, from alternator temp + charge current
  // + SoC. Degrades to "always off / unknown" if the data isn't available.
  async function analyzeTripEngine (startMs, stopMs) {
    if (options.engineAware === false) {
      return { onAt: () => false, share: null }
    }
    try {
      const [temp, current, soc] = await Promise.all([
        influx.alternatorSeries(startMs, stopMs, 120),
        influx.currentSeries(startMs, stopMs, 120),
        influx.socSeries(startMs, stopMs, 120)
      ])
      return analyzeEngine({ temp, current, soc })
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
    const trip = db.getTrip(currentTripId)
    const pos = positionNow() || {}
    // Drop maneuvers near the trip start (harbour departure). The end edge is
    // enforced when the trip completes, since the end is not known yet.
    if (trip && isEdgeManeuver(trip, m.time, pos.lat, pos.lon)) {
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

  async function scan (fromMs, toMs, stepSec) {
    const samples = await influx.sogSeries(fromMs, toMs, stepSec || 30)
    const detector = createTripDetector(detectorOpts())
    const found = []
    let open = null
    samples.forEach(([t, sog]) => {
      detector.feed(
        t,
        sog,
        (startedAt) => {
          open = { start: startedAt }
        },
        (stoppedAt) => {
          if (open) {
            open.stop = stoppedAt
            found.push(open)
            open = null
          }
        }
      )
    })

    const created = []
    for (const seg of found) {
      if (db.findOverlapping(seg.start, seg.stop)) {
        continue
      }
      const tripId = await createRetroTrip(seg.start, seg.stop)
      created.push(tripId)
    }
    return { scanned: samples.length, segments: found.length, created: created.length }
  }

  async function createRetroTrip (startMs, stopMs) {
    let distanceNm = null
    let maxSog = null
    let bounds = { start: {}, stop: {} }
    try {
      const agg = await influx.tripAggregate(startMs, stopMs)
      if (agg.meanSog != null) {
        distanceNm = (agg.meanSog * (stopMs - startMs)) / 1000 / NM
      }
      maxSog = agg.maxSog
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
      maxSog,
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
      const twa = await influx.twaSeries(startMs, stopMs, 5)
      const stw = await influx.stwSeries(startMs, stopMs, 5)
      const positions = await influx.positionSeries(startMs, stopMs, 15)
      const stwAt = new Map(stw)
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
      twa.forEach(([t, angle]) => {
        md.feed(t, angle, stwAt.has(t) ? stwAt.get(t) : null, (m) => {
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
    } catch (e) {
      app.error(`retro maneuvers failed: ${e.message}`)
    }

    geocodeTrip(tripId, 'start', bounds.start.lat, bounds.start.lon)
    geocodeTrip(tripId, 'stop', bounds.stop.lat, bounds.stop.lon)
    return tripId
  }

  function detectorOpts () {
    return {
      startKnots: options.startKnots,
      stopKnots: options.stopKnots,
      startMinSeconds: options.startMinSeconds,
      stopMinSeconds: options.stopMinSeconds,
      minTackSeconds: options.minNewTackSeconds != null ? options.minNewTackSeconds : 90,
      runDeadbandDeg: options.runDeadbandDeg != null ? options.runDeadbandDeg : 10,
      minSpeed: (options.minSailingSpeedKnots != null ? options.minSailingSpeedKnots : 2) * KNOT
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  plugin.start = function (opts) {
    options = Object.assign(
      {
        dbPath: '/storage/sailing-logbook/logbook.sqlite',
        startKnots: 0.5,
        stopKnots: 0.3,
        startMinSeconds: 180,
        stopMinSeconds: 600,
        minNewTackSeconds: 90,
        runDeadbandDeg: 10,
        minSailingSpeedKnots: 2,
        maneuverEdgeMarginMinutes: 5,
        maneuverEdgeRadiusMeters: 200,
        engineAware: true,
        motorTripPercent: 85,
        geocode: true,
        influxHost: 'localhost',
        influxPort: 8086,
        database: 'libelle',
        username: '',
        password: ''
      },
      opts || {}
    )
    geocodeEnabled = options.geocode !== false

    db = dbLib.open(options.dbPath)
    influx = influxLib.makeInflux({
      host: options.influxHost,
      port: options.influxPort,
      database: options.database,
      username: options.username,
      password: options.password
    })

    // Resume an open trip left behind by a restart.
    const active = db.getActiveTrip()
    currentTripId = active ? active.id : null

    tripDetector = createTripDetector(
      Object.assign(detectorOpts(), { initialMoving: !!active })
    )
    maneuverDetector = createManeuverDetector(detectorOpts())

    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: [
          { path: 'navigation.speedOverGround', period: 1000 },
          { path: 'navigation.speedThroughWater', period: 1000 },
          { path: 'environment.wind.angleTrueWater', period: 1000 },
          { path: 'navigation.position', period: 5000 }
        ]
      },
      unsubscribes,
      (err) => app.error('subscription error: ' + err),
      (delta) => {
        const now = Date.now()
        ;(delta.updates || []).forEach((u) => {
          ;(u.values || []).forEach((v) => {
            if (v.path === 'navigation.speedOverGround' && typeof v.value === 'number') {
              tripDetector.feed(now, v.value, onTripStart, onTripStop)
            } else if (v.path === 'navigation.speedThroughWater' && typeof v.value === 'number') {
              lastSTW = v.value
            } else if (v.path === 'environment.wind.angleTrueWater' && typeof v.value === 'number') {
              maneuverDetector.feed(now, v.value, lastSTW, onManeuver)
            } else if (v.path === 'navigation.position' && v.value && typeof v.value.latitude === 'number') {
              lastPosition = { lat: v.value.latitude, lon: v.value.longitude }
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
  }

  // ---- HTTP: read via signalKApiRoutes, writes/scan via registerWithRouter --

  function tripDetail (id) {
    const trip = db.getTrip(id)
    if (!trip) {
      return null
    }
    const events = db.getEvents(id)
    return { trip, events }
  }

  async function detailWithStats (id) {
    const base = tripDetail(id)
    if (!base) {
      return null
    }
    let hourly = []
    if (base.trip.stop_time) {
      try {
        hourly = await influx.hourlyStats(base.trip.start_time, base.trip.stop_time)
      } catch (e) {
        app.error(`hourlyStats failed: ${e.message}`)
      }
    }
    return { trip: base.trip, events: base.events, hourly }
  }

  // A trip counts as a motoring trip when the engine share meets the threshold.
  function motorTrip (trip) {
    const pct = options.motorTripPercent != null ? options.motorTripPercent : 85
    return trip.engine_share != null && trip.engine_share * 100 >= pct
  }

  function listHandler (req, res) {
    const trips = db.listTrips().map((t) =>
      Object.assign({}, t, db.countEvents(t.id), { motor: motorTrip(t) })
    )
    res.json(trips)
  }
  async function detailHandler (req, res) {
    const data = await detailWithStats(parseInt(req.params.id, 10))
    if (!data) {
      return res.status(404).json({ error: 'not found' })
    }
    data.trip = Object.assign({}, data.trip, { motor: motorTrip(data.trip) })
    res.json(data)
  }
  async function reportHandler (req, res) {
    const data = await detailWithStats(parseInt(req.params.id, 10))
    if (!data) {
      return res.status(404).send('not found')
    }
    const lang = req.query.lang === 'sv' ? 'sv' : 'en'
    const motor = motorTrip(data.trip)
    res.type('text/plain; charset=utf-8').send(report.buildReport(data.trip, data.events, data.hourly, lang, motor))
  }

  // Read-only routes, namespaced and mounted under /signalk/v1/api so the
  // server's "allow readonly access" setting lets the webapp read them without
  // admin auth (same trick as signalk-humidity-history).
  plugin.signalKApiRoutes = function (router) {
    router.get('/sailing-logbook/trips', listHandler)
    router.get('/sailing-logbook/trips/:id', detailHandler)
    router.get('/sailing-logbook/trips/:id/report', reportHandler)
    return router
  }

  // Everything under /plugins/<id> is admin-guarded by the server. The webapp
  // uses these for edits and the retro scan; reading also works here for admins.
  plugin.registerWithRouter = function (router) {
    router.get('/trips', listHandler)
    router.get('/trips/:id', detailHandler)
    router.get('/trips/:id/report', reportHandler)

    router.put('/trips/:id/place', (req, res) => {
      const id = parseInt(req.params.id, 10)
      if (!db.getTrip(id)) {
        return res.status(404).json({ error: 'not found' })
      }
      db.setManualPlace(id, {
        startPlace: req.body.startPlace != null ? req.body.startPlace : null,
        stopPlace: req.body.stopPlace != null ? req.body.stopPlace : null
      })
      res.json(db.getTrip(id))
    })

    router.delete('/trips/:id', (req, res) => {
      const id = parseInt(req.params.id, 10)
      db.deleteTrip(id)
      res.json({ ok: true })
    })

    // Manually remove a single maneuver (e.g. a false tack from a motoring leg).
    router.delete('/events/:id', (req, res) => {
      db.deleteEvent(parseInt(req.params.id, 10))
      res.json({ ok: true })
    })

    router.post('/scan', async (req, res) => {
      const from = parseInt(req.body.from, 10)
      const to = parseInt(req.body.to, 10)
      if (!from || !to || to <= from) {
        return res.status(400).json({ error: 'from/to (ms epoch) required, to > from' })
      }
      try {
        const result = await scan(from, to, req.body.stepSec)
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
      '/scan': { post: { summary: 'Retrospectively detect trips from InfluxDB', responses: { 200: { description: 'ok' } } } }
    }
  })

  return plugin
}
