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

const STR = {
  en: {
    log: 'LOG', unknown: 'unknown', tack: 'tack', gybe: 'gybe',
    hourlyIntro: 'Hourly weather, mean (p10–p90); TWA/AWA with dominant side S/P; TWD mean (±deviation):',
    heel: 'Heel', stbd: 'S', port: 'P', locale: 'en-GB', unitH: 'h', unitMin: 'min',
    and: ' and ', noManeuvers: 'No tacks or gybes',
    tacksN: (n) => `${n} ${n === 1 ? 'tack' : 'tacks'}`,
    gybesN: (n) => `${n} ${n === 1 ? 'gybe' : 'gybes'}`
  },
  sv: {
    log: 'LOGG', unknown: 'okänd', tack: 'slag', gybe: 'gipp',
    hourlyIntro: 'Timväder, medel (p10–p90); TWA/AWA med dominerande sida SB/BB; TWD medel (±avvikelse):',
    heel: 'Kräng', stbd: 'SB', port: 'BB', locale: 'sv-SE', unitH: 'h', unitMin: 'min',
    and: ' och ', noManeuvers: 'Inga slag eller gippar',
    tacksN: (n) => `${n} slag`,
    gybesN: (n) => `${n} ${n === 1 ? 'gipp' : 'gippar'}`
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
  lines.push('')

  // ---- prose summary sentence ----
  const pos = (lat, lon) => {
    const p = latLon(lat, lon)
    return p ? ` (${p})` : ''
  }
  const distFrag = trip.distance_nm != null ? `, ${fmt(trip.distance_nm, 1)} NM` : ''
  const maxFrag = trip.max_sog != null ? `, max ${fmt(toKnots(trip.max_sog), 1)} kn` : ''
  const dur = duration(trip.start_time, trip.stop_time)

  const nTacks = events.filter((e) => e.type === 'tack').length
  const nGybes = events.filter((e) => e.type === 'gybe').length
  const mParts = []
  if (nTacks > 0) {
    mParts.push(s.tacksN(nTacks))
  }
  if (nGybes > 0) {
    mParts.push(s.gybesN(nGybes))
  }
  const maneuverPhrase = mParts.length ? mParts.join(s.and) : s.noManeuvers

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

  // Timed maneuver list (detail under the prose count).
  if (events.length) {
    lines.push('')
    events.forEach((e) => {
      lines.push(`  ${clock(e.time)}  ${e.type === 'tack' ? s.tack : s.gybe}`)
    })
  }
  lines.push('')

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
