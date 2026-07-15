'use strict'

const assert = require('node:assert/strict')
const { makeInflux } = require('../plugin/lib/influx')

// Stub a single InfluxDB HTTP response (both statements come back in one body).
function stubFetch (results) {
  const orig = global.fetch
  global.fetch = async () => ({ ok: true, json: async () => ({ results }) })
  return () => { global.fetch = orig }
}

describe('trackSeries', function () {
  const influx = makeInflux({ host: 'x', port: 8086, database: 'db' })

  // Position query is result[0]; the seven scalar fields follow in the order
  // sog, stw, tws, twd, twa, awa, heel. Helper pads the ones a test ignores.
  function fieldSeries (byName) {
    const order = ['sog', 'stw', 'tws', 'twd', 'twa', 'awa', 'heel']
    return order.map((name) => ({
      series: [{ columns: ['time', 'v'], values: byName[name] || [] }]
    }))
  }

  it('joins position and the scalar fields on the shared time grid', async function () {
    const restore = stubFetch([
      { series: [{ columns: ['time', 'lat', 'lon'], values: [[1000, 59.0, 18.0], [2000, 59.1, 18.1], [3000, 59.2, 18.2]] }] },
      ...fieldSeries({
        sog: [[1000, 2.5], [3000, 4.0]], // no bucket at 2000 -> null
        heel: [[2000, 0.3]]
      })
    ])
    try {
      const track = await influx.trackSeries(0, 4000, 1)
      assert.deepEqual(track, [
        { t: 1000, lat: 59.0, lon: 18.0, sog: 2.5, stw: null, tws: null, twd: null, twa: null, awa: null, heel: null },
        { t: 2000, lat: 59.1, lon: 18.1, sog: null, stw: null, tws: null, twd: null, twa: null, awa: null, heel: 0.3 },
        { t: 3000, lat: 59.2, lon: 18.2, sog: 4.0, stw: null, tws: null, twd: null, twa: null, awa: null, heel: null }
      ])
    } finally {
      restore()
    }
  })

  it('drops position rows with a missing coordinate', async function () {
    const restore = stubFetch([
      { series: [{ columns: ['time', 'lat', 'lon'], values: [[1000, 59.0, 18.0], [2000, null, 18.1]] }] },
      ...fieldSeries({ sog: [[1000, 3.0]] })
    ])
    try {
      const track = await influx.trackSeries(0, 3000, 1)
      assert.deepEqual(track, [
        { t: 1000, lat: 59.0, lon: 18.0, sog: 3.0, stw: null, tws: null, twd: null, twa: null, awa: null, heel: null }
      ])
    } finally {
      restore()
    }
  })

  it('returns an empty track when there is no position data', async function () {
    const restore = stubFetch([{ series: [] }, ...fieldSeries({})])
    try {
      assert.deepEqual(await influx.trackSeries(0, 1000, 1), [])
    } finally {
      restore()
    }
  })
})

describe('awaSeries (maneuver fallback)', function () {
  const influx = makeInflux({ host: 'x', port: 8086, database: 'db' })

  it('returns [t, angle] pairs and drops nulls', async function () {
    const restore = stubFetch([
      { series: [{ columns: ['time', 'v'], values: [[1000, 0.5], [2000, null], [3000, -0.4]] }] }
    ])
    try {
      assert.deepEqual(await influx.awaSeries(0, 4000, 5), [[1000, 0.5], [3000, -0.4]])
    } finally {
      restore()
    }
  })

  it('returns [] when apparent wind has no data', async function () {
    const restore = stubFetch([{ series: [] }])
    try {
      assert.deepEqual(await influx.awaSeries(0, 1000, 5), [])
    } finally {
      restore()
    }
  })
})
