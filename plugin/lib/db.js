/*
 * SQLite persistence. Only events are stored here: trip boundaries, positions,
 * and tack/gybe markers. Hourly wind/heel statistics are NOT stored; they are
 * computed on demand from InfluxDB (see influx.js), so there is no stale cache.
 *
 * All timestamps are integer milliseconds since the epoch (UTC).
 */

// Node's built-in SQLite (Node >= 22.5). No native dependency to compile on the
// Pi, and nothing that can break when Signal K upgrades Node. It emits a
// one-time ExperimentalWarning on load, which is harmless.
const { DatabaseSync } = require('node:sqlite')
const path = require('path')
const fs = require('fs')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trips (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  start_time         INTEGER NOT NULL,
  stop_time          INTEGER,
  start_lat          REAL,
  start_lon          REAL,
  stop_lat           REAL,
  stop_lon           REAL,
  start_place        TEXT,
  stop_place         TEXT,
  start_place_manual TEXT,
  stop_place_manual  TEXT,
  distance_nm        REAL,
  max_sog            REAL,
  max_stw            REAL,
  engine_share       REAL,
  status             TEXT NOT NULL DEFAULT 'active',
  origin             TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_trips_start ON trips(start_time);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  time       INTEGER NOT NULL,
  type       TEXT NOT NULL,
  twa_before REAL,
  twa_after  REAL,
  lat        REAL,
  lon        REAL
);
CREATE INDEX IF NOT EXISTS idx_events_trip ON events(trip_id);

-- Named places: a user-given name anchored at a position. A trip's start/stop
-- shows the nearest place within a radius (see index.js), so naming a spot once
-- applies to every trip that starts or ends near it, past and future.
CREATE TABLE IF NOT EXISTS places (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lat  REAL NOT NULL,
  lon  REAL NOT NULL
);
`

function open (filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  // Migrations for columns added to existing databases. A "duplicate column"
  // error means the column is already in SCHEMA (fresh DB) and is benign;
  // anything else (locked, corrupt) must surface, not hide.
  for (const col of ['engine_share REAL', 'max_stw REAL']) {
    try {
      db.exec(`ALTER TABLE trips ADD COLUMN ${col}`)
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) {
        throw e
      }
    }
  }

  const stmts = {
    insertTrip: db.prepare(
      `INSERT INTO trips (start_time, start_lat, start_lon, status, origin)
       VALUES (@start_time, @start_lat, @start_lon, 'active', @origin)`
    ),
    insertCompleteTrip: db.prepare(
      `INSERT INTO trips
         (start_time, stop_time, start_lat, start_lon, stop_lat, stop_lon,
          distance_nm, max_stw, status, origin)
       VALUES
         (@start_time, @stop_time, @start_lat, @start_lon, @stop_lat, @stop_lon,
          @distance_nm, @max_stw, 'complete', @origin)`
    ),
    completeTrip: db.prepare(
      `UPDATE trips
          SET stop_time = @stop_time, stop_lat = @stop_lat, stop_lon = @stop_lon,
              distance_nm = @distance_nm, max_stw = @max_stw, status = 'complete'
        WHERE id = @id`
    ),
    setMaxStw: db.prepare('UPDATE trips SET max_stw = @max_stw WHERE id = @id'),
    completeTripWindows: db.prepare(
      "SELECT id, start_time, stop_time FROM trips " +
        "WHERE status = 'complete' AND stop_time IS NOT NULL"
    ),
    setGeocode: db.prepare(
      `UPDATE trips SET start_place = COALESCE(@start_place, start_place),
                        stop_place  = COALESCE(@stop_place, stop_place)
        WHERE id = @id`
    ),
    allPlaces: db.prepare('SELECT * FROM places'),
    insertPlace: db.prepare('INSERT INTO places (name, lat, lon) VALUES (@name, @lat, @lon)'),
    updatePlaceName: db.prepare('UPDATE places SET name = @name WHERE id = @id'),
    deletePlaceById: db.prepare('DELETE FROM places WHERE id = ?'),
    insertEvent: db.prepare(
      `INSERT INTO events (trip_id, time, type, twa_before, twa_after, lat, lon)
       VALUES (@trip_id, @time, @type, @twa_before, @twa_after, @lat, @lon)`
    ),
    deleteEventById: db.prepare('DELETE FROM events WHERE id = ?'),
    setEngineShare: db.prepare('UPDATE trips SET engine_share = @share WHERE id = @id'),
    getTrip: db.prepare('SELECT * FROM trips WHERE id = ?'),
    listTrips: db.prepare('SELECT * FROM trips ORDER BY start_time DESC'),
    activeTrip: db.prepare(
      "SELECT * FROM trips WHERE status = 'active' ORDER BY start_time DESC LIMIT 1"
    ),
    tripEvents: db.prepare('SELECT * FROM events WHERE trip_id = ? ORDER BY time ASC'),
    countEvents: db.prepare(
      "SELECT type, COUNT(*) AS n FROM events WHERE trip_id = ? GROUP BY type"
    ),
    overlapping: db.prepare(
      // An active trip (stop_time NULL) is still ongoing, so it overlaps any
      // window reaching its start; treating its end as start_time would collapse
      // it to a point and let a scan create a duplicate inside a live trip.
      `SELECT * FROM trips
        WHERE start_time <= @stop_time
          AND (stop_time IS NULL OR stop_time >= @start_time)
        LIMIT 1`
    ),
    deleteTrip: db.prepare('DELETE FROM trips WHERE id = ?')
  }

  return {
    raw: db,

    createActiveTrip ({ startTime, lat, lon, origin }) {
      const info = stmts.insertTrip.run({
        start_time: startTime,
        start_lat: lat != null ? lat : null,
        start_lon: lon != null ? lon : null,
        origin: origin || 'live'
      })
      return info.lastInsertRowid
    },

    createCompleteTrip (t) {
      const info = stmts.insertCompleteTrip.run({
        start_time: t.startTime,
        stop_time: t.stopTime,
        start_lat: t.startLat != null ? t.startLat : null,
        start_lon: t.startLon != null ? t.startLon : null,
        stop_lat: t.stopLat != null ? t.stopLat : null,
        stop_lon: t.stopLon != null ? t.stopLon : null,
        distance_nm: t.distanceNm != null ? t.distanceNm : null,
        max_stw: t.maxStw != null ? t.maxStw : null,
        origin: t.origin || 'live'
      })
      return info.lastInsertRowid
    },

    completeTrip (id, t) {
      stmts.completeTrip.run({
        id,
        stop_time: t.stopTime,
        stop_lat: t.stopLat != null ? t.stopLat : null,
        stop_lon: t.stopLon != null ? t.stopLon : null,
        distance_nm: t.distanceNm != null ? t.distanceNm : null,
        max_stw: t.maxStw != null ? t.maxStw : null
      })
    },

    // Backfill support: every complete trip's window, for (re)computing max_stw.
    completeTripWindows () {
      return stmts.completeTripWindows.all()
    },

    setMaxStw (id, maxStw) {
      stmts.setMaxStw.run({ id, max_stw: maxStw != null ? maxStw : null })
    },

    setGeocode (id, { startPlace, stopPlace }) {
      stmts.setGeocode.run({
        id,
        start_place: startPlace != null ? startPlace : null,
        stop_place: stopPlace != null ? stopPlace : null
      })
    },

    listPlaces () {
      return stmts.allPlaces.all()
    },

    insertPlace ({ name, lat, lon }) {
      return stmts.insertPlace.run({ name, lat, lon }).lastInsertRowid
    },

    updatePlaceName (id, name) {
      stmts.updatePlaceName.run({ id, name })
    },

    deletePlace (id) {
      stmts.deletePlaceById.run(id)
    },

    // One-time migration guard via SQLite's user_version, used to seed the places
    // table from pre-existing manual place names exactly once.
    userVersion () {
      return this.raw.prepare('PRAGMA user_version').get().user_version
    },

    setUserVersion (n) {
      // PRAGMA doesn't take a bound parameter; n is an integer we control.
      this.raw.exec(`PRAGMA user_version = ${Math.trunc(n)}`)
    },

    addEvent (e) {
      stmts.insertEvent.run({
        trip_id: e.tripId,
        time: e.time,
        type: e.type,
        twa_before: e.twaBefore != null ? e.twaBefore : null,
        twa_after: e.twaAfter != null ? e.twaAfter : null,
        lat: e.lat != null ? e.lat : null,
        lon: e.lon != null ? e.lon : null
      })
    },

    deleteEvent (id) {
      stmts.deleteEventById.run(id)
    },

    setEngineShare (id, share) {
      stmts.setEngineShare.run({ id, share: share != null ? share : null })
    },

    getTrip (id) {
      return stmts.getTrip.get(id)
    },

    getActiveTrip () {
      return stmts.activeTrip.get()
    },

    listTrips () {
      return stmts.listTrips.all()
    },

    getEvents (tripId) {
      return stmts.tripEvents.all(tripId)
    },

    countEvents (tripId) {
      const rows = stmts.countEvents.all(tripId)
      const out = { tack: 0, gybe: 0 }
      rows.forEach((r) => {
        out[r.type] = r.n
      })
      return out
    },

    findOverlapping (startTime, stopTime) {
      return stmts.overlapping.get({ start_time: startTime, stop_time: stopTime })
    },

    deleteTrip (id) {
      stmts.deleteTrip.run(id)
    },

    close () {
      db.close()
    }
  }
}

module.exports = { open }
