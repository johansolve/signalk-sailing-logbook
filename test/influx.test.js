'use strict'

const assert = require('node:assert/strict')
const { makeInflux } = require('../plugin/lib/influx')

// Stub a single InfluxDB HTTP response (both statements come back in one body).
function stubFetch (results) {
  const orig = global.fetch
  global.fetch = async () => ({ ok: true, json: async () => ({ results }) })
  return () => { global.fetch = orig }
}

// Like stubFetch, but counts the requests and keeps each one's query text, so a
// test can assert that the position is read in a single round trip and that both
// of its statements share one time grid.
function stubFetchCounting (results) {
  const orig = global.fetch
  const state = { calls: 0, queries: [] }
  global.fetch = async (url) => {
    state.calls++
    state.queries.push(new URL(String(url)).searchParams.get('q'))
    return { ok: true, json: async () => ({ results }) }
  }
  return { state, restore: () => { global.fetch = orig } }
}

// signalk-to-influxdb's JSON position field, as it writes it.
const jsonPos = (lat, lon) => JSON.stringify({ longitude: lon, latitude: lat })

// The two position statements come back first, then the scalar fields.
const posResults = (latlon, json) => [
  { series: latlon ? [{ columns: ['time', 'lat', 'lon'], values: latlon }] : [] },
  { series: json ? [{ columns: ['time', 'p'], values: json }] : [] }
]

describe('trackSeries', function () {
  const influx = makeInflux({ host: 'x', port: 8086, database: 'db' })

  // The two position statements are results[0] and [1]; the seven scalar fields
  // follow in the order sog, stw, tws, twd, twa, awa, heel. Helper pads the ones
  // a test ignores.
  function fieldSeries (byName) {
    const order = ['sog', 'stw', 'tws', 'twd', 'twa', 'awa', 'heel']
    return order.map((name) => ({
      series: [{ columns: ['time', 'v'], values: byName[name] || [] }]
    }))
  }

  it('joins position and the scalar fields on the shared time grid', async function () {
    const restore = stubFetch([
      ...posResults([[1000, 59.0, 18.0], [2000, 59.1, 18.1], [3000, 59.2, 18.2]], []),
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
      ...posResults([[1000, 59.0, 18.0], [2000, null, 18.1]], []),
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
    const restore = stubFetch([...posResults(null, null), ...fieldSeries({})])
    try {
      assert.deepEqual(await influx.trackSeries(0, 1000, 1), [])
    } finally {
      restore()
    }
  })

  // signalk-to-influxdb only writes lat/lon when its separateLatLon option is
  // on; with it off the position is a JSON string in "jsonValue".
  it('reads the JSON position field and still joins the scalars', async function () {
    const { state, restore } = stubFetchCounting([
      ...posResults([], [[1000, jsonPos(59.0, 18.0)], [2000, jsonPos(59.1, 18.1)]]),
      ...fieldSeries({ sog: [[1000, 2.5]], heel: [[2000, 0.3]] })
    ])
    try {
      const track = await influx.trackSeries(0, 3000, 1)
      assert.deepEqual(track, [
        { t: 1000, lat: 59.0, lon: 18.0, sog: 2.5, stw: null, tws: null, twd: null, twa: null, awa: null, heel: null },
        { t: 2000, lat: 59.1, lon: 18.1, sog: null, stw: null, tws: null, twd: null, twa: null, awa: null, heel: 0.3 }
      ])
      assert.equal(state.calls, 1, 'the position costs one round trip, not two')
    } finally {
      restore()
    }
  })

  // Switching separateLatLon on part-way leaves older buckets with only the JSON
  // string and newer ones with both. Reading whichever field answers first would
  // start the track at the flip; the merge covers the whole window.
  it('covers a window where only part of the history has lat/lon', async function () {
    const restore = stubFetch([
      ...posResults(
        [[3000, 59.2, 18.2], [4000, 59.3, 18.3]],
        [[1000, jsonPos(59.0, 18.0)], [2000, jsonPos(59.1, 18.1)], [3000, jsonPos(59.25, 18.25)]]
      ),
      ...fieldSeries({})
    ])
    try {
      const track = await influx.trackSeries(0, 5000, 1)
      assert.deepEqual(track.map((p) => [p.t, p.lat, p.lon]), [
        [1000, 59.0, 18.0],
        [2000, 59.1, 18.1],
        // Both shapes cover this bucket: the averaged floats win over the sample.
        [3000, 59.2, 18.2],
        [4000, 59.3, 18.3]
      ])
    } finally {
      restore()
    }
  })

  it('asks for both position shapes on one grid, in one request', async function () {
    const { state, restore } = stubFetchCounting([
      ...posResults([[1000, 59.0, 18.0]], []), ...fieldSeries({})
    ])
    try {
      await influx.trackSeries(0, 2000, 30)
      assert.equal(state.calls, 1)
      const q = state.queries[0]
      assert.ok(q.includes('mean("lat")') && q.includes('first("jsonValue")'))
      // Every statement in the batch must bucket identically, or the join keys
      // stop matching and each point loses its conditions.
      assert.equal((q.match(/GROUP BY time\(30s\)/g) || []).length, 9)
    } finally {
      restore()
    }
  })

  it('drops unparseable and incomplete JSON positions', async function () {
    const restore = stubFetch([
      ...posResults([], [
        [1000, 'not json'],
        [2000, JSON.stringify({ latitude: 59.1 })],
        // A fix with no lock: null coordinates must be dropped, not coerced to 0.
        [3000, JSON.stringify({ longitude: null, latitude: null })],
        [4000, null],
        [5000, jsonPos(59.2, 18.2)]
      ]),
      ...fieldSeries({})
    ])
    try {
      const track = await influx.trackSeries(0, 6000, 1)
      assert.deepEqual(track.map((p) => [p.t, p.lat, p.lon]), [[5000, 59.2, 18.2]])
    } finally {
      restore()
    }
  })
})

describe('positionSeries', function () {
  const influx = makeInflux({ host: 'x', port: 8086, database: 'db' })

  it('merges both position shapes, floats winning a shared bucket', async function () {
    const { state, restore } = stubFetchCounting(posResults(
      [[2000, 59.1, 18.1], [3000, null, 18.2]],
      [[1000, jsonPos(59.0, 18.0)], [2000, jsonPos(59.15, 18.15)]]
    ))
    try {
      assert.deepEqual(await influx.positionSeries(0, 4000, 15), [
        [1000, 59.0, 18.0],
        [2000, 59.1, 18.1]
      ])
      assert.equal(state.calls, 1)
    } finally {
      restore()
    }
  })

  // The merge fills a Map from the JSON first and the floats second, so a float
  // bucket older than every JSON one is inserted last and only the sort puts it
  // back where it belongs.
  it('returns the merged buckets in time order', async function () {
    const restore = stubFetch(posResults(
      [[1000, 59.0, 18.0]],
      [[2000, jsonPos(59.1, 18.1)], [3000, jsonPos(59.2, 18.2)]]
    ))
    try {
      assert.deepEqual((await influx.positionSeries(0, 4000, 15)).map((r) => r[0]), [1000, 2000, 3000])
    } finally {
      restore()
    }
  })

  it('reads a database that has only the JSON field', async function () {
    const restore = stubFetch(posResults(null, [[1000, jsonPos(59.0, 18.0)]]))
    try {
      assert.deepEqual(await influx.positionSeries(0, 2000, 15), [[1000, 59.0, 18.0]])
    } finally {
      restore()
    }
  })

  it('returns nothing when neither shape has a position', async function () {
    const restore = stubFetch(posResults(null, null))
    try {
      assert.deepEqual(await influx.positionSeries(0, 2000, 15), [])
    } finally {
      restore()
    }
  })
})

describe('hasPositionHistory', function () {
  const influx = makeInflux({ host: 'x', port: 8086, database: 'db' })

  it('is true when the measurement exists', async function () {
    const { state, restore } = stubFetchCounting([
      { series: [{ columns: ['name'], values: [['navigation.position']] }] }
    ])
    try {
      assert.equal(await influx.hasPositionHistory(), true)
      assert.ok(state.queries[0].startsWith('SHOW MEASUREMENTS'), 'metadata query, not a scan')
    } finally {
      restore()
    }
  })

  it('is false when nothing has ever written a position', async function () {
    const restore = stubFetch([{}])
    try {
      assert.equal(await influx.hasPositionHistory(), false)
    } finally {
      restore()
    }
  })
})

describe('positionBounds', function () {
  const influx = makeInflux({ host: 'x', port: 8086, database: 'db' })

  // The JSON field is written for every position, so it spans the whole window;
  // the floats only start wherever separateLatLon was switched on. Trusting the
  // floats would date a trip's start to the flip instead of to its first fix.
  it('prefers the JSON field, which is the complete series', async function () {
    const { state, restore } = stubFetchCounting([
      { series: [{ columns: ['time', 'slat', 'slon', 'elat', 'elon'], values: [[0, 59.2, 18.2, 59.5, 18.5]] }] },
      { series: [{ columns: ['time', 's', 'e'], values: [[0, jsonPos(59.0, 18.0), jsonPos(59.5, 18.5)]] }] }
    ])
    try {
      assert.deepEqual(await influx.positionBounds(0, 3000), {
        start: { lat: 59.0, lon: 18.0 },
        stop: { lat: 59.5, lon: 18.5 }
      })
      assert.equal(state.calls, 1)
    } finally {
      restore()
    }
  })

  // Each end falls back on its own: a malformed string at one end must not throw
  // away the float answer that end had, or a retro trip is left without it.
  it('falls back per end when only one JSON string parses', async function () {
    const restore = stubFetch([
      { series: [{ columns: ['time', 'slat', 'slon', 'elat', 'elon'], values: [[0, 59.2, 18.2, 59.5, 18.5]] }] },
      { series: [{ columns: ['time', 's', 'e'], values: [[0, jsonPos(59.0, 18.0), 'not json']] }] }
    ])
    try {
      assert.deepEqual(await influx.positionBounds(0, 3000), {
        start: { lat: 59.0, lon: 18.0 },
        stop: { lat: 59.5, lon: 18.5 }
      })
    } finally {
      restore()
    }
  })

  it('falls back to the float fields when there is no JSON', async function () {
    const restore = stubFetch([
      { series: [{ columns: ['time', 'slat', 'slon', 'elat', 'elon'], values: [[0, 59.0, 18.0, 59.5, 18.5]] }] },
      { series: [] }
    ])
    try {
      assert.deepEqual(await influx.positionBounds(0, 3000), {
        start: { lat: 59.0, lon: 18.0 },
        stop: { lat: 59.5, lon: 18.5 }
      })
    } finally {
      restore()
    }
  })

  it('reports nulls when neither shape has a position', async function () {
    const restore = stubFetch([{ series: [] }, { series: [] }])
    try {
      assert.deepEqual(await influx.positionBounds(0, 3000), {
        start: { lat: null, lon: null },
        stop: { lat: null, lon: null }
      })
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
