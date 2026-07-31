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

describe('channelSeries', function () {
  const influx = makeInflux({ host: 'x', port: 8086, database: 'db' })

  // Like stubFetch, but keeps the query string so a test can assert on the SQL.
  function stubFetchQuery (results) {
    const orig = global.fetch
    const seen = { q: null }
    global.fetch = async (url) => {
      seen.q = new URL(String(url)).searchParams.get('q')
      return { ok: true, json: async () => ({ results }) }
    }
    return { seen, restore: () => { global.fetch = orig } }
  }

  it('joins the named channels on the shared grid, null where a bucket is empty', async function () {
    const { restore } = stubFetchQuery([
      { series: [{ columns: ['time', 'v'], values: [[1000, 3.1], [2000, 3.4]] }] },
      { series: [{ columns: ['time', 'v'], values: [[2000, 5.0], [3000, null]] }] }
    ])
    try {
      assert.deepEqual(await influx.channelSeries(0, 4000, 5, ['twd', 'tws']), [
        { t: 1000, twd: 3.1, tws: null },
        { t: 2000, twd: 3.4, tws: 5.0 }
      ])
    } finally {
      restore()
    }
  })

  it('samples angles and averages the rest', async function () {
    const { seen, restore } = stubFetchQuery([{ series: [] }, { series: [] }])
    try {
      await influx.channelSeries(0, 4000, 10, ['twd', 'stw'])
      assert.match(seen.q, /first\("value"\) AS v FROM "environment\.wind\.directionTrue"/)
      assert.match(seen.q, /mean\("value"\) AS v FROM "navigation\.speedThroughWater"/)
      assert.match(seen.q, /GROUP BY time\(10s\)/)
    } finally {
      restore()
    }
  })

  it('ignores channels it cannot serve, and queries nothing when none are left', async function () {
    const { seen, restore } = stubFetchQuery([{ series: [] }])
    try {
      // position has no "value" column and engine state is a string.
      assert.deepEqual(await influx.channelSeries(0, 4000, 5, ['position', 'engineState', 'nope']), [])
      assert.equal(seen.q, null)
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

describe('engineStateSeries', function () {
  const influx = makeInflux({ host: 'x', port: 8086, database: 'db' })

  it('seeds an old pre-window state instead of back-filling a mid-trip start', async function () {
    // The Flakfortet→Rungsted bug: after >24 h of sailing the last engine
    // transition ('stopped') long predates the trip, and a single mid-trip
    // 'started' must not be projected back across the whole window (that read a
    // sail as 100 % motoring). result[0] is the seed, result[1] the in-window rows.
    const restore = stubFetch([
      { series: [{ columns: ['time', 'v'], values: [[1000, 'stopped']] }] },
      { series: [{ columns: ['time', 'v'], values: [[190000, 'started']] }] }
    ])
    try {
      assert.deepEqual(
        await influx.engineStateSeries(100000, 200000),
        [[100000, 'stopped'], [190000, 'started'], [200000, 'started']]
      )
    } finally {
      restore()
    }
  })

  it('with no prior state, seeds the opposite of the first in-window transition', async function () {
    // Every in-window row is a transition, so a 'started' at 150000 means it was
    // 'stopped' from the trip start until then.
    const restore = stubFetch([
      { series: [] },
      { series: [{ columns: ['time', 'v'], values: [[150000, 'started']] }] }
    ])
    try {
      assert.deepEqual(
        await influx.engineStateSeries(100000, 200000),
        [[100000, 'stopped'], [150000, 'started'], [200000, 'started']]
      )
    } finally {
      restore()
    }
  })

  it('returns [] when there is no state anywhere (engine unknown)', async function () {
    const restore = stubFetch([{ series: [] }, { series: [] }])
    try {
      assert.deepEqual(await influx.engineStateSeries(100000, 200000), [])
    } finally {
      restore()
    }
  })
})
