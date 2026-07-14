/*
 * Builds a plain-text logbook entry for a completed trip, ready to paste into
 * the skipper's own logbook. Input is the trip row, its events, the hourly
 * statistics from influx.hourlyStats(), and a language ('en' or 'sv'). All
 * SI->display conversion happens here.
 *
 * Wind speed is reported in m/s; boat speed in knots; distance in nautical
 * miles; all angles in degrees. Times are always in the boat's timezone.
 */

const MS_PER_KNOT = 0.514444
const RAD = 180 / Math.PI
const TZ = 'Europe/Stockholm'

const STR = {
  en: {
    log: 'LOG', date: 'Date', departure: 'Departure', arrival: 'Arrival',
    duration: 'Duration', distance: 'Distance', maxSpeed: 'Max speed', unknown: 'unknown',
    maneuvers: 'Maneuvers', tacks: 'tacks', gybes: 'gybes', tack: 'tack', gybe: 'gybe',
    hourlyIntro: 'Hourly weather, mean (p10–p90); TWA/AWA with dominant side S/P; TWD mean (±deviation):',
    hr: 'Hr', heel: 'Heel', stbd: 'S', port: 'P', locale: 'en-GB',
    unitH: 'h', unitMin: 'min'
  },
  sv: {
    log: 'LOGG', date: 'Datum', departure: 'Avgång', arrival: 'Ankomst',
    duration: 'Restid', distance: 'Distans', maxSpeed: 'Max fart', unknown: 'okänd',
    maneuvers: 'Manövrar', tacks: 'slag', gybes: 'gippar', tack: 'slag', gybe: 'gipp',
    hourlyIntro: 'Timväder, medel (p10–p90); TWA/AWA med dominerande sida SB/BB; TWD medel (±avvikelse):',
    hr: 'Tim', heel: 'Kräng', stbd: 'SB', port: 'BB', locale: 'sv-SE',
    unitH: 'h', unitMin: 'min'
  }
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
  lines.push(`${s.date}: ${dateStr(trip.start_time)}`)
  lines.push('')

  // Align the label column to the widest label in this language.
  const labels = [s.departure, s.arrival, s.duration, s.distance, s.maxSpeed]
  const lw = Math.max(...labels.map((x) => x.length)) + 1
  const label = (x) => (x + ':').padEnd(lw + 1)

  const startPos = latLon(trip.start_lat, trip.start_lon)
  const stopPos = latLon(trip.stop_lat, trip.stop_lon)
  lines.push(`${label(s.departure)} ${clock(trip.start_time)}  ${startPlace}${startPos ? '  ' + startPos : ''}`)
  lines.push(`${label(s.arrival)} ${clock(trip.stop_time)}  ${stopPlace}${stopPos ? '  ' + stopPos : ''}`)
  lines.push(`${label(s.duration)} ${duration(trip.start_time, trip.stop_time)}`)
  if (trip.distance_nm != null) {
    lines.push(`${label(s.distance)} ${fmt(trip.distance_nm, 1)} NM`)
  }
  if (trip.max_sog != null) {
    lines.push(`${label(s.maxSpeed)} ${fmt(toKnots(trip.max_sog), 1)} kn`)
  }
  lines.push('')

  const nTacks = events.filter((e) => e.type === 'tack').length
  const nGybes = events.filter((e) => e.type === 'gybe').length
  lines.push(`${s.maneuvers}: ${nTacks} ${s.tacks}, ${nGybes} ${s.gybes}`)
  events.forEach((e) => {
    lines.push(`  ${clock(e.time)}  ${e.type === 'tack' ? s.tack : s.gybe}`)
  })
  lines.push('')

  if (hourly && hourly.length) {
    lines.push(s.hourlyIntro)
    lines.push(
      `${s.hr.padEnd(5)}${'TWS m/s'.padEnd(15)}${'STW kn'.padEnd(15)}${'TWD °'.padEnd(11)}` +
      `${'TWA °'.padEnd(17)}${'AWA °'.padEnd(17)}${s.heel} °`
    )
    const range1 = (mean, p10, p90) => `${fmt(mean, 1)} (${fmt(p10, 1)}-${fmt(p90, 1)})`
    const range0 = (mean, p10, p90) => `${fmt(mean)} (${fmt(p10)}-${fmt(p90)})`
    const angleSide = (o) => `${fmt(toDeg(o.mean))}${sideLetter(o.side)} (${fmt(toDeg(o.p10))}-${fmt(toDeg(o.p90))})`
    hourly.forEach((h) => {
      const tws = h.tws || {}
      const stw = h.stw || {}
      const twd = h.twd || {}
      const twa = h.twa || {}
      const awa = h.awa || {}
      const heel = h.heel || {}
      const twsCol = range1(tws.mean, tws.p10, tws.p90)
      const stwCol = range1(toKnots(stw.mean), toKnots(stw.p10), toKnots(stw.p90))
      const twdCol = twd.mean != null ? `${fmt(toDeg(twd.mean))} (±${fmt(toDeg(twd.std))})` : '–'
      const twaCol = angleSide(twa)
      const awaCol = angleSide(awa)
      const heelCol = range0(toDeg(heel.mean), toDeg(heel.p10), toDeg(heel.p90))
      lines.push(
        `${hourLabel(h.time).padEnd(2)}   ${twsCol.padEnd(14)} ${stwCol.padEnd(14)} ${twdCol.padEnd(10)} ` +
        `${twaCol.padEnd(16)} ${awaCol.padEnd(16)} ${heelCol}`
      )
    })
  }

  return lines.join('\n')
}

module.exports = { buildReport }
