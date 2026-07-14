/*
 * Engine-on detection, layered from most to least confident:
 *
 *  1. Battery charge current > 5 A  -> engine ON. Under way the only thing that
 *     pushes that much into the house bank is the engine-driven alternator;
 *     solar minus the boat's 3-4 A idle draw never nets above ~1 A.
 *  2. Charge current <= 1 A and SoC < 100 % -> engine OFF. If the engine were
 *     running with room to charge, the alternator would be pushing current.
 *  3. Otherwise fall back to the alternator temperature slope: rising = on,
 *     falling = cooling down (off), flat-and-hot = running, flat-and-cool = off.
 *     This carries the ambiguous cases, e.g. motoring with a full battery where
 *     the alternator tapers off and the current is low.
 *
 * Inputs are three ascending series of [timeMs, value]: alternator temperature
 * (°C), house current (A, positive = charging), and state of charge (0..1). Any
 * may be empty. Returns the engine state at any time and the fraction of the
 * window the engine was on.
 */

function analyzeEngine (series, opts) {
  opts = opts || {}
  const hotC = opts.hotC != null ? opts.hotC : 30
  const riseSlope = opts.riseSlope != null ? opts.riseSlope : 0.03 // °C/min
  const coolSlope = opts.coolSlope != null ? opts.coolSlope : 0.02 // °C/min
  const windowMs = (opts.slopeWindowSec != null ? opts.slopeWindowSec : 600) * 1000
  const onCurrent = opts.onCurrentA != null ? opts.onCurrentA : 5
  const offCurrent = opts.offCurrentA != null ? opts.offCurrentA : 1
  const fullSoc = opts.fullSoc != null ? opts.fullSoc : 0.995

  const temp = (series.temp || []).filter((p) => p[1] != null)
  const current = (series.current || []).filter((p) => p[1] != null)
  const soc = (series.soc || []).filter((p) => p[1] != null)

  const grid = temp.length ? temp : current
  if (grid.length < 2) {
    return { share: null, onAt: () => false, samples: 0 }
  }

  const nearest = (arr, t) => {
    let best = null
    let bd = Infinity
    for (const [pt, v] of arr) {
      const d = Math.abs(pt - t)
      if (d < bd) {
        bd = d
        best = v
      }
    }
    return best
  }

  // Alternator-temperature slope classifier, evaluated at the nearest sample.
  const tempOnAt = (t) => {
    if (!temp.length) {
      return false
    }
    let i = 0
    let bd = Infinity
    for (let k = 0; k < temp.length; k++) {
      const d = Math.abs(temp[k][0] - t)
      if (d < bd) {
        bd = d
        i = k
      }
    }
    let j0 = i
    let j1 = i
    while (j0 > 0 && temp[i][0] - temp[j0][0] < windowMs) {
      j0--
    }
    while (j1 < temp.length - 1 && temp[j1][0] - temp[i][0] < windowMs) {
      j1++
    }
    const dtMin = (temp[j1][0] - temp[j0][0]) / 60000
    const slope = dtMin > 0 ? (temp[j1][1] - temp[j0][1]) / dtMin : 0
    if (slope > riseSlope) {
      return true
    }
    if (slope < -coolSlope) {
      return false
    }
    return temp[i][1] > hotC
  }

  const decide = (t) => {
    const c = nearest(current, t)
    const s = nearest(soc, t)
    if (c != null && c > onCurrent) {
      return true
    }
    if (c != null && c <= offCurrent && s != null && s < fullSoc) {
      return false
    }
    return tempOnAt(t)
  }

  const on = grid.map((p) => decide(p[0]))
  let onMs = 0
  let totalMs = 0
  for (let i = 1; i < grid.length; i++) {
    const seg = grid[i][0] - grid[i - 1][0]
    totalMs += seg
    if (on[i - 1]) {
      onMs += seg
    }
  }
  const share = totalMs > 0 ? onMs / totalMs : null

  const onAt = (timeMs) => {
    let i = 0
    let bd = Infinity
    for (let k = 0; k < grid.length; k++) {
      const d = Math.abs(grid[k][0] - timeMs)
      if (d < bd) {
        bd = d
        i = k
      }
    }
    return !!on[i]
  }

  return { share, onAt, samples: grid.length }
}

module.exports = { analyzeEngine }
