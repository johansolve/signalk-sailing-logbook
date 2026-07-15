/*
 * InfluxDB 1.x access. The onboard signalk-to-influxdb stores every Signal K
 * path as its own measurement with the sample in the "value" column, positions
 * additionally as "lat"/"lon". All statistics are derived here from that raw
 * history, so nothing is duplicated into SQLite.
 *
 * Every query is bounded to a real [startMs, stopMs] window, which also excludes
 * the handful of mis-timestamped GPS points (epoch 0 and year-2061) that the
 * eMux source occasionally writes.
 *
 * Wind speeds are m/s, angles radians; conversion to display units happens in
 * report.js / the webapp, not here.
 */

const DEFAULT_PATHS = {
  sog: 'navigation.speedOverGround',
  stw: 'navigation.speedThroughWater',
  tws: 'environment.wind.speedTrue',
  twa: 'environment.wind.angleTrueWater',
  awa: 'environment.wind.angleApparent',
  twd: 'environment.wind.directionTrue',
  heel: 'navigation.attitude.roll',
  engineState: 'propulsion.0.state',
  position: 'navigation.position'
}

function quoteMeasurement (m) {
  return m.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function makeInflux (config) {
  const paths = Object.assign({}, DEFAULT_PATHS, config.paths || {})
  const base = `http://${config.host}:${config.port}/query`

  async function run (statements) {
    const params = new URLSearchParams({
      db: config.database,
      epoch: 'ms',
      q: Array.isArray(statements) ? statements.join('; ') : statements
    })
    if (config.username) {
      params.set('u', config.username)
      params.set('p', config.password || '')
    }
    const resp = await fetch(`${base}?${params.toString()}`, {
      signal: AbortSignal.timeout(config.timeoutMs || 30000)
    })
    if (!resp.ok) {
      throw new Error(`InfluxDB HTTP ${resp.status}`)
    }
    const body = await resp.json()
    if (body.error) {
      throw new Error(body.error)
    }
    return (body.results || []).map((r) => {
      if (r.error) {
        throw new Error(r.error)
      }
      const serie = r.series && r.series[0]
      return {
        columns: serie ? serie.columns : [],
        values: serie ? serie.values : []
      }
    })
  }

  function window (a, b) {
    // Coerce to integer epoch-ms so nothing but a number can reach the query,
    // even if a caller ever passes an unsanitised value.
    const lo = Math.trunc(Number(a))
    const hi = Math.trunc(Number(b))
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('window bounds must be numeric epoch-ms')
    }
    return `time >= ${lo}ms AND time <= ${hi}ms`
  }

  function rowsToObjects (result) {
    const { columns, values } = result
    return values.map((v) => {
      const o = {}
      columns.forEach((c, i) => {
        o[c] = v[i]
      })
      return o
    })
  }

  return {
    // Per-hour statistics across the trip window. p10/p90 are the "significant"
    // min/max (raw extremes filtered out); angles and heel use the absolute
    // value so mean pointing angle / mean heel magnitude are not cancelled out
    // by tacking from one side to the other.
    async hourlyStats (startMs, stopMs) {
      const w = window(startMs, stopMs)
      const plainStat = (measurement) =>
        `SELECT mean("value") AS mean, percentile("value",10) AS p10, ` +
        `percentile("value",90) AS p90, max("value") AS max ` +
        `FROM "${quoteMeasurement(measurement)}" WHERE ${w} GROUP BY time(1h) fill(none)`
      const absStat = (measurement) =>
        `SELECT mean(a) AS mean, percentile(a,10) AS p10, percentile(a,90) AS p90 ` +
        `FROM (SELECT abs("value") AS a FROM "${quoteMeasurement(measurement)}" WHERE ${w}) ` +
        `GROUP BY time(1h) fill(none)`
      // Like absStat but also returns the mean sign (side): >0 starboard, <0 port.
      // The magnitude is reported (robust to tacking and to ±180° wraparound near
      // a dead run) with the dominant side shown separately.
      const absSideStat = (measurement) =>
        `SELECT mean(a) AS mean, percentile(a,10) AS p10, percentile(a,90) AS p90, mean(s) AS side ` +
        `FROM (SELECT abs("value") AS a, "value"/abs("value") AS s ` +
        `FROM "${quoteMeasurement(measurement)}" WHERE ${w}) ` +
        `GROUP BY time(1h) fill(none)`

      // TWD is a compass direction, so a plain mean is wrong (350deg and 10deg
      // must average to 0, not 180). Take the mean of the unit vectors and
      // recover direction and spread from the resultant client-side.
      const twdM = quoteMeasurement(paths.twd)

      const results = await run([
        plainStat(paths.tws),
        plainStat(paths.stw),
        absSideStat(paths.twa),
        absSideStat(paths.awa),
        absStat(paths.heel),
        `SELECT mean(s) AS ms, mean(c) AS mc ` +
          `FROM (SELECT sin("value") AS s, cos("value") AS c FROM "${twdM}" WHERE ${w}) ` +
          `GROUP BY time(1h) fill(none)`
      ])

      const buckets = new Map()
      const bucket = (t) => {
        if (!buckets.has(t)) {
          buckets.set(t, { time: t })
        }
        return buckets.get(t)
      }
      const merge = (result, key) => {
        rowsToObjects(result).forEach((row) => {
          bucket(row.time)[key] = {
            mean: row.mean,
            p10: row.p10,
            p90: row.p90,
            max: row.max != null ? row.max : undefined,
            side: row.side != null ? row.side : undefined
          }
        })
      }
      merge(results[0], 'tws')
      merge(results[1], 'stw')
      merge(results[2], 'twa')
      merge(results[3], 'awa')
      merge(results[4], 'heel')

      // Circular mean direction and angular deviation (both radians). The
      // angular deviation grows with how much the wind shifted within the hour.
      rowsToObjects(results[5]).forEach((row) => {
        if (row.ms == null || row.mc == null) {
          return
        }
        const R = Math.hypot(row.ms, row.mc)
        let mean = Math.atan2(row.ms, row.mc)
        if (mean < 0) {
          mean += 2 * Math.PI
        }
        const std = R > 0 ? Math.sqrt(-2 * Math.log(Math.min(1, R))) : null
        bucket(row.time).twd = { mean, std }
      })

      return Array.from(buckets.values()).sort((x, y) => x.time - y.time)
    },

    // Mean/max SOG over the window; used to estimate distance at completion.
    async tripAggregate (startMs, stopMs) {
      const m = quoteMeasurement(paths.sog)
      const [res] = await run(
        `SELECT mean("value") AS mean, max("value") AS max ` +
          `FROM "${m}" WHERE ${window(startMs, stopMs)}`
      )
      const row = rowsToObjects(res)[0] || {}
      return { meanSog: row.mean != null ? row.mean : null, maxSog: row.max != null ? row.max : null }
    },

    // Downsampled SOG series (m/s) for retrospective trip detection.
    async sogSeries (startMs, stopMs, stepSec) {
      const m = quoteMeasurement(paths.sog)
      const [res] = await run(
        `SELECT mean("value") AS v FROM "${m}" ` +
          `WHERE ${window(startMs, stopMs)} ` +
          `GROUP BY time(${stepSec || 30}s) fill(none)`
      )
      return res.values.map((v) => [v[0], v[1]]).filter((p) => p[1] != null)
    },

    // Propulsion state history published by signalk-derived-engine-state, bracketed to
    // the trip window as [[startMs, state], ...transitions..., [stopMs, state]].
    //
    // State is a step function that only changes on transitions, so the raw
    // in-window rows are sparse and, crucially, omit whatever state was already
    // in effect at startMs. We therefore seed the left edge with the last value
    // at or before startMs and close the right edge at stopMs, so both the share
    // integral and the onAt step function are correct across the whole window.
    //
    // Returns [] (and the caller falls back to the alternator/current
    // derivation) when there is no state data at all for the window, e.g. trips
    // before the plugin ran or an influxdb writer that doesn't store this string
    // path.
    async engineStateSeries (startMs, stopMs) {
      const m = quoteMeasurement(paths.engineState)
      const seedTime = Math.trunc(Number(startMs))
      let results
      try {
        results = await run([
          `SELECT last("value") AS v FROM "${m}" WHERE time <= ${seedTime}ms`,
          `SELECT "value" AS v FROM "${m}" WHERE ${window(startMs, stopMs)}`
        ])
      } catch (e) {
        return []
      }
      const seedRow = rowsToObjects(results[0])[0]
      // A seed older than this predates the plugin running for this stretch, so
      // it says nothing about the trip; don't let one stale value shadow the
      // alternator fallback for a whole trip.
      const seedMaxAgeMs = 24 * 3600 * 1000
      const seedFresh =
        seedRow != null &&
        seedRow.v != null &&
        seedRow.time != null &&
        startMs - seedRow.time <= seedMaxAgeMs
      // Drop any point exactly at startMs; the seeded left bracket covers it.
      const inWindow = results[1].values
        .map((v) => [v[0], v[1]])
        .filter((p) => p[1] != null && p[0] > startMs)
      let leftState
      if (seedFresh) {
        leftState = seedRow.v
      } else if (inWindow.length) {
        // No trustworthy seed, but there are transitions inside the window, so the
        // plugin was publishing during the trip: assume the first in-window state
        // held just before it.
        leftState = inWindow[0][1]
      } else {
        // No trustworthy state for this window -> caller falls back to the
        // alternator/current derivation.
        return []
      }
      const series = [[startMs, leftState], ...inWindow]
      const last = series[series.length - 1]
      if (last[0] < stopMs) {
        series.push([stopMs, last[1]])
      }
      return series
    },

    // Downsampled STW series (m/s) on the same grid as twaSeries, used to gate
    // retrospective maneuvers by boat speed.
    async stwSeries (startMs, stopMs, stepSec) {
      const m = quoteMeasurement(paths.stw)
      const [res] = await run(
        `SELECT mean("value") AS v FROM "${m}" ` +
          `WHERE ${window(startMs, stopMs)} ` +
          `GROUP BY time(${stepSec || 5}s) fill(none)`
      )
      return res.values.map((v) => [v[0], v[1]]).filter((p) => p[1] != null)
    },

    // Downsampled position series [[t, lat, lon], ...] used to place retro
    // maneuvers for the geographic edge gate.
    async positionSeries (startMs, stopMs, stepSec) {
      const m = quoteMeasurement(paths.position)
      const [res] = await run(
        `SELECT mean("lat") AS lat, mean("lon") AS lon FROM "${m}" ` +
          `WHERE ${window(startMs, stopMs)} ` +
          `GROUP BY time(${stepSec || 15}s) fill(none)`
      )
      return res.values.map((v) => [v[0], v[1], v[2]]).filter((p) => p[1] != null && p[2] != null)
    },

    // First and last known position within the window; used to place retro
    // trips that have no live position. The position measurement stores lat/lon
    // as separate float fields.
    async positionBounds (startMs, stopMs) {
      const m = quoteMeasurement(paths.position)
      const [res] = await run(
        `SELECT first("lat") AS slat, first("lon") AS slon, ` +
          `last("lat") AS elat, last("lon") AS elon ` +
          `FROM "${m}" WHERE ${window(startMs, stopMs)}`
      )
      const row = rowsToObjects(res)[0] || {}
      return {
        start: { lat: row.slat != null ? row.slat : null, lon: row.slon != null ? row.slon : null },
        stop: { lat: row.elat != null ? row.elat : null, lon: row.elon != null ? row.elon : null }
      }
    },

    // Downsampled TWA series (rad) for retrospective maneuver detection.
    async twaSeries (startMs, stopMs, stepSec) {
      const m = quoteMeasurement(paths.twa)
      const [res] = await run(
        `SELECT mean("value") AS v FROM "${m}" ` +
          `WHERE ${window(startMs, stopMs)} ` +
          `GROUP BY time(${stepSec || 5}s) fill(none)`
      )
      return res.values.map((v) => [v[0], v[1]]).filter((p) => p[1] != null)
    }
  }
}

module.exports = { makeInflux, DEFAULT_PATHS }
