'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const dbLib = require('../plugin/lib/db')

const T = 1700000000000
const h = 3600000

function freshDb () {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-')), 'test.sqlite')
  return dbLib.open(file)
}

describe('db', function () {
  it('creates and reads back an active trip', function () {
    const db = freshDb()
    const id = db.createActiveTrip({ startTime: T, lat: 59, lon: 18, origin: 'live' })
    const trip = db.getTrip(id)
    assert.equal(trip.status, 'active')
    assert.equal(trip.stop_time, null)
    assert.equal(db.getActiveTrip().id, id)
    db.close()
  })

  it('findOverlapping treats an active trip as ongoing', function () {
    const db = freshDb()
    db.createActiveTrip({ startTime: T + 10 * h, lat: 59, lon: 18, origin: 'live' })
    // a window in the middle of the still-open trip overlaps it
    assert.ok(db.findOverlapping(T + 12 * h, T + 13 * h))
    // a window entirely before it does not
    assert.equal(db.findOverlapping(T + 8 * h, T + 9 * h), undefined)
    db.close()
  })

  it('counts events by type and cascades on trip delete', function () {
    const db = freshDb()
    const id = db.createCompleteTrip({ startTime: T, stopTime: T + h, origin: 'retro' })
    db.addEvent({ tripId: id, time: T + 100, type: 'tack' })
    db.addEvent({ tripId: id, time: T + 200, type: 'gybe' })
    db.addEvent({ tripId: id, time: T + 300, type: 'tack' })
    assert.deepEqual(db.countEvents(id), { tack: 2, gybe: 1 })
    db.deleteTrip(id)
    assert.equal(db.getEvents(id).length, 0)
    db.close()
  })

  it('stores, renames and deletes named places', function () {
    const db = freshDb()
    const id = db.insertPlace({ name: 'Grötvik', lat: 56.641, lon: 12.7802 })
    assert.deepEqual(db.listPlaces().map((p) => p.name), ['Grötvik'])
    db.updatePlaceName(id, 'Hemmahamn')
    assert.equal(db.listPlaces()[0].name, 'Hemmahamn')
    db.deletePlace(id)
    assert.equal(db.listPlaces().length, 0)
    db.close()
  })

  it('tracks the one-time seed guard via user_version', function () {
    const db = freshDb()
    assert.equal(db.userVersion(), 0)
    db.setUserVersion(1)
    assert.equal(db.userVersion(), 1)
    db.close()
  })

  it('reopening an existing database keeps its data (migration is idempotent)', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-'))
    const file = path.join(dir, 'test.sqlite')
    const a = dbLib.open(file)
    const id = a.createActiveTrip({ startTime: T, origin: 'live' })
    a.setEngineShare(id, 0.42)
    a.close()
    const b = dbLib.open(file) // runs the schema + ALTER migration again
    assert.equal(b.getTrip(id).engine_share, 0.42)
    b.close()
  })
})
