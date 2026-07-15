/*
 * Engine-on for a trip, read from a propulsion.*.state history published by the
 * signalk-derived-engine-state plugin (live and backfilled). The detection logic lives
 * there; this only interprets the resulting step function. There is no local
 * re-derivation from alternator/current anymore, so the logic exists in one place.
 */

// Turn a propulsion.*.state history ([timeMs, 'started'|'stopped'|'unusable'],
// ascending) into the on-fraction and a state lookup. Returns null when there
// isn't enough to go on, so the caller can treat the engine as unknown.
function fromStateSeries (series) {
  const s = (series || []).filter((p) => p[1] != null)
  if (s.length < 2) {
    return null
  }
  const isOn = (v) => v === 'started'
  let onMs = 0
  let totalMs = 0
  for (let i = 1; i < s.length; i++) {
    const seg = s[i][0] - s[i - 1][0]
    totalMs += seg
    if (isOn(s[i - 1][1])) {
      onMs += seg
    }
  }
  const share = totalMs > 0 ? onMs / totalMs : null

  // State is a step function: the value holds until the next change.
  const onAt = (t) => {
    let cur = s[0][1]
    for (const [pt, v] of s) {
      if (pt <= t) {
        cur = v
      } else {
        break
      }
    }
    return isOn(cur)
  }

  return { share, onAt, samples: s.length }
}

module.exports = { fromStateSeries }
