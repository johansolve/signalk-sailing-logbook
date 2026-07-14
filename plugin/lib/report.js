/*
 * Builds a plain-text logbook entry for a completed trip, ready to paste into
 * the skipper's own logbook. Input is the trip row, its events, the hourly
 * statistics from influx.hourlyStats(), and a language ('en' or 'sv'). All
 * SI->display conversion happens here.
 *
 * The summary is prose; the hourly weather is one self-labelled line per hour so
 * it survives being pasted into a proportional-font editor.
 *
 * Wind speed is reported in m/s; boat speed in knots; distance in nautical
 * miles; all angles in degrees. Times are always in the boat's timezone.
 */

const MS_PER_KNOT = 0.514444
const RAD = 180 / Math.PI
const TZ = 'Europe/Stockholm'

// Spell out small counts for more natural prose; digits beyond twelve. Swedish
// "one" is gendered: ett slag (neuter), en gipp (common).
const NUM = {
  en: (n) => ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][n] || String(n),
  sv: (n, g) =>
    n === 1
      ? (g === 'ett' ? 'ett' : 'en')
      : (['', '', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta', 'nio', 'tio', 'elva', 'tolv'][n] || String(n))
}

const STR = {
  en: {
    log: 'LOG', unknown: 'unknown', tack: 'tack', gybe: 'gybe',
    hourlyIntro: 'Hourly weather, mean (p10–p90); TWA/AWA with dominant side S/P; TWD mean (±deviation):',
    heel: 'Heel', stbd: 'S', port: 'P', locale: 'en-GB', unitH: 'h', unitMin: 'min',
    and: ' and ', noManeuvers: 'No tacks or gybes',
    tacksN: (n) => `${NUM.en(n)} ${n === 1 ? 'tack' : 'tacks'}`,
    gybesN: (n) => `${NUM.en(n)} ${n === 1 ? 'gybe' : 'gybes'}`,
    cardinals: ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'],
    bands: ['close-hauled', 'a reach', 'a broad reach', 'a run'],
    windLead: 'Wind', atFirst: 'at first', veer: 'veering to', back: 'backing to',
    buildTo: 'building to', easeTo: 'easing to',
    boreAway: 'as the boat bore away from', headedUp: 'as the boat headed up from', toBand: 'to',
    steady: 'steady', gusty: 'gusty', fairlySteady: 'fairly steady',
    heelEase: 'heel easing from', heelBuild: 'heel building from', heelAround: 'heel around', heelTo: 'to'
  },
  sv: {
    log: 'LOGG', unknown: 'okänd', tack: 'slag', gybe: 'gipp',
    hourlyIntro: 'Timväder, medel (p10–p90); TWA/AWA med dominerande sida SB/BB; TWD medel (±avvikelse):',
    heel: 'Kräng', stbd: 'SB', port: 'BB', locale: 'sv-SE', unitH: 'h', unitMin: 'min',
    and: ' och ', noManeuvers: 'Inga slag eller gippar',
    tacksN: (n) => `${NUM.sv(n, 'ett')} slag`,
    gybesN: (n) => `${NUM.sv(n, 'en')} ${n === 1 ? 'gipp' : 'gippar'}`,
    cardinals: ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSV', 'SV', 'VSV', 'V', 'VNV', 'NV', 'NNV'],
    bands: ['bidevind', 'halvvind', 'slör', 'läns'],
    windLead: 'Vind', atFirst: 'inledningsvis', veer: 'vridande mot', back: 'backande mot',
    buildTo: 'ökande till', easeTo: 'avtagande till',
    boreAway: 'när båten föll av från', headedUp: 'när båten lovade från', toBand: 'till',
    steady: 'jämn vind', gusty: 'byig vind', fairlySteady: 'ganska jämn vind',
    heelEase: 'krängning avtagande från', heelBuild: 'krängning tilltagande från', heelAround: 'krängning kring', heelTo: 'till'
  }
}

// Best-effort narrative summary of the wind over the trip, from simple
// first-vs-last comparisons of the hourly stats. Clauses drop out when a trend
// is weak, so it degrades to a plain statement rather than inventing a story.
// Returns null if there isn't enough data.
function windSummary (hourly, s, toDeg, fmt) {
  if (!hourly) {
    return null
  }
  const H = hourly.filter((h) => h.tws && h.tws.mean != null)
  if (H.length < 2) {
    return null
  }
  const a = H[0]
  const b = H[H.length - 1]
  const card = (deg) => s.cardinals[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
  const twdA = a.twd && a.twd.mean != null ? toDeg(a.twd.mean) : null
  const twdB = b.twd && b.twd.mean != null ? toDeg(b.twd.mean) : null
  const twsA = a.tws.mean
  const twsB = b.tws.mean
  const heelA = a.heel && a.heel.mean != null ? toDeg(a.heel.mean) : null
  const heelB = b.heel && b.heel.mean != null ? toDeg(b.heel.mean) : null

  // Direction trend (veer/back), only if a clear shift.
  let dir = ''
  if (twdA != null && twdB != null) {
    const d = ((twdB - twdA + 540) % 360) - 180
    if (d > 15) {
      dir = `${s.veer} ${card(twdB)}`
    } else if (d < -15) {
      dir = `${s.back} ${card(twdB)}`
    }
  }
  // Speed trend.
  let spd = ''
  const ds = twsB - twsA
  if (ds > 1) {
    spd = `${s.buildTo} ~${fmt(twsB)} m/s`
  } else if (ds < -1) {
    spd = `${s.easeTo} ~${fmt(twsB)} m/s`
  }
  // Point-of-sail change from mean |TWA|.
  const band = (o) => {
    if (!o || o.mean == null) {
      return null
    }
    const deg = toDeg(o.mean)
    return deg < 55 ? 0 : deg < 100 ? 1 : deg < 150 ? 2 : 3
  }
  const b1 = band(a.twa)
  const b2 = band(b.twa)
  let sail = ''
  if (b1 != null && b2 != null && b1 !== b2) {
    const verb = b2 > b1 ? s.boreAway : s.headedUp
    sail = `${verb} ${s.bands[b1]} ${s.toBand} ${s.bands[b2]}`
  }
  // Gustiness from the mean TWS p10–p90 spread.
  const spreads = H.filter((h) => h.tws.p10 != null && h.tws.p90 != null).map((h) => h.tws.p90 - h.tws.p10)
  let steadiness = ''
  if (spreads.length) {
    const avg = spreads.reduce((x, y) => x + y, 0) / spreads.length
    steadiness = avg > 4 ? s.gusty : avg < 2 ? s.steady : s.fairlySteady
  }
  // Heel trend.
  let heel = ''
  if (heelA != null && heelB != null) {
    const dh = heelB - heelA
    if (dh < -2) {
      heel = `${s.heelEase} ~${fmt(heelA)}° ${s.heelTo} ~${fmt(heelB)}°`
    } else if (dh > 2) {
      heel = `${s.heelBuild} ~${fmt(heelA)}° ${s.heelTo} ~${fmt(heelB)}°`
    } else {
      heel = `${s.heelAround} ~${fmt(Math.round((heelA + heelB) / 2))}°`
    }
  }

  let str = twdA != null
    ? `${s.windLead} ${card(twdA)} ~${fmt(twsA)} m/s ${s.atFirst}`
    : `${s.windLead} ~${fmt(twsA)} m/s ${s.atFirst}`
  const trend = [dir, spd].filter(Boolean)
  if (trend.length) {
    str += ', ' + trend.join(s.and)
  }
  if (sail) {
    str += ' ' + sail
  }
  const tail = [steadiness, heel].filter(Boolean)
  if (tail.length) {
    str += '; ' + tail.join(', ')
  }
  return str + '.'
}

function buildReport (trip, events, hourly, lang) {
  const s = STR[lang] || STR.en
  const locale = s.locale

  const toKnots = (ms) => (ms == null ? null : ms / MS_PER_KNOT)
  const toDeg = (rad) => (rad == null ? null : rad * RAD)
  const fmt = (v, digits) =>
    v == null
      ? '–'
      : v.toLocaleString(locale, { minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0 })

  const clock = (ms) =>
    ms == null ? '–' : new Date(ms).toLocaleTimeString(locale, { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
  const dateStr = (ms) => new Date(ms).toLocaleDateString(locale, { timeZone: TZ })
  const hourLabel = (ms) =>
    new Date(ms).toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit' }).padStart(2, '0')

  const duration = (fromMs, toMs) => {
    if (fromMs == null || toMs == null) {
      return '–'
    }
    const min = Math.round((toMs - fromMs) / 60000)
    const h = Math.floor(min / 60)
    const m = min % 60
    return h > 0 ? `${h} ${s.unitH} ${m} ${s.unitMin}` : `${m} ${s.unitMin}`
  }

  // Degrees + decimal minutes, e.g. 56°38.5'N 012°46.8'E (universal nav format).
  const latLon = (lat, lon) => {
    if (lat == null || lon == null) {
      return null
    }
    const one = (v, pos, neg, degWidth) => {
      const hemi = v >= 0 ? pos : neg
      const abs = Math.abs(v)
      const deg = Math.floor(abs)
      const minutes = (abs - deg) * 60
      return `${String(deg).padStart(degWidth, '0')}°${minutes.toFixed(1).padStart(4, '0')}'${hemi}`
    }
    return `${one(lat, 'N', 'S', 2)} ${one(lon, 'E', 'W', 3)}`
  }

  const placeOf = (row, which) => row[`${which}_place_manual`] || row[`${which}_place`] || null
  const sideLetter = (sign) => (sign == null ? '' : ' ' + (sign >= 0 ? s.stbd : s.port))

  const startPlace = placeOf(trip, 'start') || s.unknown
  const stopPlace = placeOf(trip, 'stop') || s.unknown
  const lines = []

  lines.push(`${s.log}  ${startPlace} → ${stopPlace}`)
  lines.push('')

  // ---- prose summary sentence ----
  const pos = (lat, lon) => {
    const p = latLon(lat, lon)
    return p ? ` (${p})` : ''
  }
  const distFrag = trip.distance_nm != null ? `, ${fmt(trip.distance_nm, 1)} NM` : ''
  const maxFrag = trip.max_sog != null ? `, max ${fmt(toKnots(trip.max_sog), 1)} kn` : ''
  const dur = duration(trip.start_time, trip.stop_time)

  // Maneuver phrase with the times folded in, e.g. "one gybe (18:40)" or
  // "three tacks (10:12, 10:45, 11:30) and one gybe (14:05)".
  const tackTimes = events.filter((e) => e.type === 'tack').map((e) => clock(e.time))
  const gybeTimes = events.filter((e) => e.type === 'gybe').map((e) => clock(e.time))
  const mParts = []
  if (tackTimes.length) {
    mParts.push(`${s.tacksN(tackTimes.length)} (${tackTimes.join(', ')})`)
  }
  if (gybeTimes.length) {
    mParts.push(`${s.gybesN(gybeTimes.length)} (${gybeTimes.join(', ')})`)
  }
  let maneuverPhrase = mParts.length ? mParts.join(s.and) : s.noManeuvers
  // It forms its own sentence, so capitalise the first letter.
  maneuverPhrase = maneuverPhrase.charAt(0).toUpperCase() + maneuverPhrase.slice(1)

  const sp = `${startPlace} ${clock(trip.start_time)}${pos(trip.start_lat, trip.start_lon)}`
  const ep = `${stopPlace} ${clock(trip.stop_time)}${pos(trip.stop_lat, trip.stop_lon)}`
  if (lang === 'sv') {
    lines.push(
      `Segling ${dateStr(trip.start_time)}. Avgång ${sp}, ankomst ${ep}. ` +
      `Restid ${dur}${distFrag}${maxFrag}. ${maneuverPhrase}.`
    )
  } else {
    lines.push(
      `Passage ${dateStr(trip.start_time)}. Departed ${sp}, arrived ${ep}. ` +
      `${dur}${distFrag}${maxFrag}. ${maneuverPhrase}.`
    )
  }

  lines.push('')

  // ---- derived wind narrative above the hourly detail ----
  const wind = windSummary(hourly, s, toDeg, fmt)
  if (wind) {
    lines.push(wind)
    lines.push('')
  }

  // ---- hourly weather, one self-labelled line per hour ----
  if (hourly && hourly.length) {
    lines.push(s.hourlyIntro)
    const spd = (label, m, a, b, unit) =>
      `${label} ${fmt(m, 1)} ${unit} (${fmt(a, 1)}-${fmt(b, 1)})`
    const ang = (label, o) =>
      `${label} ${fmt(toDeg(o.mean))}°${sideLetter(o.side)} (${fmt(toDeg(o.p10))}-${fmt(toDeg(o.p90))})`
    hourly.forEach((h) => {
      const tws = h.tws || {}
      const stw = h.stw || {}
      const twd = h.twd || {}
      const twa = h.twa || {}
      const awa = h.awa || {}
      const heel = h.heel || {}
      const parts = [
        spd('TWS', tws.mean, tws.p10, tws.p90, 'm/s'),
        spd('STW', toKnots(stw.mean), toKnots(stw.p10), toKnots(stw.p90), 'kn'),
        twd.mean != null ? `TWD ${fmt(toDeg(twd.mean))}° (±${fmt(toDeg(twd.std))})` : 'TWD –',
        ang('TWA', twa),
        ang('AWA', awa),
        ang(s.heel, heel)
      ]
      lines.push(`${hourLabel(h.time)}:  ${parts.join(', ')}`)
    })
  }

  return lines.join('\n')
}

module.exports = { buildReport }
