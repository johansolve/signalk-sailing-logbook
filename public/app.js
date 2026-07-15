'use strict'

// Read endpoints (anonymous, honour "allow readonly access").
const READ = '/signalk/v1/api/sailing-logbook'
// Write/scan endpoints (admin-guarded by the server).
const ADMIN = '/plugins/signalk-sailing-logbook'

// ---- i18n ----------------------------------------------------------------
// Language: ?lang= override, else browser preference, else English.
const STR = {
  en: {
    title: 'Logbook', scanHistory: 'Scan history',
    scanHint: 'Scans the InfluxDB history and creates any trips that are missing. Overlapping trips are skipped. Requires admin login.',
    from: 'From', to: 'To', scan: 'Scan',
    date: 'Date', route: 'From → To', duration: 'Duration', distance: 'Distance', max: 'Max', tacksGybes: 'Tacks/Gybes',
    noTrips: 'No trips yet. Go sailing, or scan the history above.', back: '← Back',
    underWay: '(under way)', loading: 'Loading…', unknown: 'Unknown',
    startPlace: 'Start place', endPlace: 'End place', place: 'Place', savePlaces: 'Save places',
    placeHint: 'A named place is reused for every trip starting or ending within a 250 m radius. Clear a field and save to remove its name.',
    confirmDeletePlace: 'Remove this place name? Every trip near it reverts to the looked-up name.',
    speed: 'Speed',
    hourlyWeather: 'Hourly weather', hr: 'Hr', heel: 'Heel',
    unitNote: 'Mean with p10–p90 range; TWA/AWA show the dominant side (S/P); TWD is the circular mean with ±angular deviation.',
    noWeather: 'No weather statistics (trip has no end time or no data).',
    tack: 'Tack', gybe: 'Gybe',
    gybeSing: 'gybe', gybePlur: 'gybes', tackSing: 'tack', tackPlur: 'tacks',
    andWord: 'and', noManeuvers: 'No gybes or tacks',
    copyReport: 'Copy logbook entry', deleteTrip: 'Delete trip',
    removeManeuver: 'Remove this maneuver', stbd: 'S', port: 'P', motor: 'motor',
    motorHour: 'Motor', motorTime: 'engine',
    couldNotLoadTrips: 'Could not load trips: ', couldNotLoadTrip: 'Could not load trip: ',
    placesSaved: 'Places saved', couldNotSave: 'Could not save: ', adminLogin: 'requires admin login',
    copied: 'Logbook entry copied to clipboard', copyManually: 'Copy manually from the box below',
    couldNotFetchReport: 'Could not fetch report: ', couldNotRemove: 'Could not remove maneuver: ',
    couldNotDelete: 'Could not delete: ', confirmDeleteTrip: 'Delete this trip permanently?',
    pickDates: 'Pick a from and to date', scanning: 'Scanning…', error: 'Error: ',
    scanDone: (c, f, s) => `Done: ${c} new trips (${f} found, ${s} samples).`
  },
  sv: {
    title: 'Loggbok', scanHistory: 'Skanna historik',
    scanHint: 'Skannar InfluxDB-historiken och skapar trips som saknas. Överlappande trips hoppas över. Kräver admin-inloggning.',
    from: 'Från', to: 'Till', scan: 'Skanna',
    date: 'Datum', route: 'Från → Till', duration: 'Restid', distance: 'Distans', max: 'Max', tacksGybes: 'Slag/Gipp',
    noTrips: 'Inga trips än. Segla, eller skanna historiken ovan.', back: '← Tillbaka',
    underWay: '(pågår)', loading: 'Laddar…', unknown: 'Okänd',
    startPlace: 'Startplats', endPlace: 'Slutplats', place: 'Plats', savePlaces: 'Spara platser',
    placeHint: 'Ett platsnamn återanvänds för alla trips som startar eller slutar inom 250 m radie. Töm ett fält och spara för att ta bort namnet.',
    confirmDeletePlace: 'Ta bort platsnamnet? Alla trips nära det återgår till det uppslagna namnet.',
    speed: 'Fart',
    hourlyWeather: 'Timväder', hr: 'Tim', heel: 'Kräng',
    unitNote: 'Medel med p10–p90-intervall; TWA/AWA visar dominerande sida (SB/BB); TWD är cirkulärt medel med ±vinkelavvikelse.',
    noWeather: 'Ingen väderstatistik (tripen saknar sluttid eller data).',
    tack: 'Slag', gybe: 'Gipp',
    gybeSing: 'gipp', gybePlur: 'gippar', tackSing: 'slag', tackPlur: 'slag',
    andWord: 'och', noManeuvers: 'Inga gippar eller slag',
    copyReport: 'Kopiera loggbokstext', deleteTrip: 'Ta bort trip',
    removeManeuver: 'Ta bort manövern', stbd: 'SB', port: 'BB', motor: 'motor',
    motorHour: 'Motor', motorTime: 'motor',
    couldNotLoadTrips: 'Kunde inte hämta trips: ', couldNotLoadTrip: 'Kunde inte hämta trip: ',
    placesSaved: 'Platser sparade', couldNotSave: 'Kunde inte spara: ', adminLogin: 'kräver admin-inloggning',
    copied: 'Loggbokstext kopierad till urklipp', copyManually: 'Kopiera manuellt från rutan nedan',
    couldNotFetchReport: 'Kunde inte hämta rapport: ', couldNotRemove: 'Kunde inte ta bort manöver: ',
    couldNotDelete: 'Kunde inte ta bort: ', confirmDeleteTrip: 'Ta bort denna trip permanent?',
    pickDates: 'Välj från- och till-datum', scanning: 'Skannar…', error: 'Fel: ',
    scanDone: (c, f, s) => `Klart: ${c} nya trips (${f} hittade, ${s} sampel).`
  }
}

const LANG = (() => {
  const forced = new URLSearchParams(location.search).get('lang')
  if (forced && STR[forced]) {
    return forced
  }
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase()
  return STR[nav] ? nav : 'en'
})()
const LOCALE = LANG === 'sv' ? 'sv-SE' : 'en-GB'
const t = (k) => STR[LANG][k]

const MS_PER_KNOT = 0.514444
const RAD = 180 / Math.PI

const $ = (sel) => document.querySelector(sel)

// The one live Leaflet map, torn down and rebuilt each time a detail is opened,
// plus its track points so a maneuver-row click can locate the moment on it.
let trackMap = null
let trackPoints = []

function toKnots (ms) {
  return ms == null ? null : ms / MS_PER_KNOT
}
function toDeg (rad) {
  return rad == null ? null : rad * RAD
}
function n (v, d) {
  return v == null
    ? '–'
    : v.toLocaleString(LOCALE, { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 })
}
// Dominant side from the mean sign: >=0 starboard, <0 port.
function sideLetter (s) {
  return s == null ? '' : ' ' + (s >= 0 ? t('stbd') : t('port'))
}

function fmtDate (ms) {
  return new Date(ms).toLocaleDateString(LOCALE)
}
function fmtTime (ms) {
  return ms == null ? '–' : new Date(ms).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
}
function fmtDuration (a, b) {
  if (a == null || b == null) {
    return '–'
  }
  const min = Math.round((b - a) / 60000)
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
function placeOf (tr, which) {
  return tr[`${which}_place_manual`] || tr[`${which}_place`] || ''
}
function pct (v) {
  return LANG === 'sv' ? `${n(v)} %` : `${n(v)}%`
}
// Motoring time of the total, shown for any trip that ran the engine at all.
function engineFrag (tr) {
  if (tr.engine_share == null || tr.engine_share <= 0.005 || tr.start_time == null || tr.stop_time == null) {
    return ''
  }
  const motorMs = (tr.stop_time - tr.start_time) * tr.engine_share
  return ` · ${t('motorTime')} ${fmtDuration(0, motorMs)} (${pct(tr.engine_share * 100)})`
}

function setStatus (msg, isError) {
  const el = $('#status')
  el.textContent = msg || ''
  el.classList.toggle('error', !!isError)
}

async function getJSON (url) {
  const r = await fetch(url)
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}`)
  }
  return r.json()
}

// ---- list view -----------------------------------------------------------

async function loadList () {
  showView('list')
  try {
    const trips = await getJSON(`${READ}/trips`)
    renderList(trips)
    setStatus('')
  } catch (e) {
    setStatus(t('couldNotLoadTrips') + e.message, true)
  }
}

function renderList (trips) {
  const tbody = $('#trip-rows')
  tbody.innerHTML = ''
  $('#empty').hidden = trips.length > 0
  trips.forEach((tr) => {
    const row = document.createElement('tr')
    row.className = 'trip-row'
    const from = placeOf(tr, 'start') || '—'
    const to = placeOf(tr, 'stop') || (tr.status === 'active' ? t('underWay') : '—')
    row.innerHTML = `
      <td>${fmtDate(tr.start_time)}</td>
      <td class="route">${escapeHtml(from)} → ${escapeHtml(to)}${tr.motor ? ` <span class="tag">${t('motor')}</span>` : ''}</td>
      <td>${fmtDuration(tr.start_time, tr.stop_time)}</td>
      <td class="num">${tr.distance_nm != null ? n(tr.distance_nm, 1) + ' NM' : '–'}</td>
      <td class="num">${tr.max_sog != null ? n(toKnots(tr.max_sog), 1) + ' kn' : '–'}</td>
      <td class="num">${tr.tack || 0}/${tr.gybe || 0}</td>`
    row.addEventListener('click', () => loadDetail(tr.id))
    tbody.appendChild(row)
  })
}

// ---- detail view ---------------------------------------------------------

async function loadDetail (id) {
  showView('detail')
  $('#detail').innerHTML = `<p class="hint">${t('loading')}</p>`
  try {
    const data = await getJSON(`${READ}/trips/${id}`)
    renderDetail(data)
    setStatus('')
  } catch (e) {
    $('#detail').innerHTML = ''
    setStatus(t('couldNotLoadTrip') + e.message, true)
  }
}

// One table cell: mean value followed by its range in parentheses.
function cell (mean, range) {
  const r = range ? `<span class="rng">(${range})</span>` : ''
  return `<td class="num"><span class="m">${mean}</span> ${r}</td>`
}

function renderDetail (data) {
  const tr = data.trip
  const el = $('#detail')
  const rows = (data.hourly || []).map((h) => {
    const tws = h.tws || {}
    const stw = h.stw || {}
    const twd = h.twd || {}
    const twa = h.twa || {}
    const awa = h.awa || {}
    const heel = h.heel || {}
    // Under engine the pointing angles are meaningless, so a single Motor badge
    // spans the TWA and AWA columns for the hour.
    const twaAwa = h.motor
      ? `<td class="motor-cell" colspan="2"><span class="tag">${t('motorHour')}</span></td>`
      : `${cell(n(toDeg(twa.mean)) + sideLetter(twa.side), `${n(toDeg(twa.p10))}–${n(toDeg(twa.p90))}`)}
         ${cell(n(toDeg(awa.mean)) + sideLetter(awa.side), `${n(toDeg(awa.p10))}–${n(toDeg(awa.p90))}`)}`
    return `<tr>
      <td>${fmtTime(h.time)}</td>
      ${cell(n(toKnots(stw.mean), 1), `${n(toKnots(stw.p10), 1)}–${n(toKnots(stw.p90), 1)}`)}
      ${cell(n(tws.mean, 1), `${n(tws.p10, 1)}–${n(tws.p90, 1)}`)}
      ${cell(twd.mean != null ? n(toDeg(twd.mean)) : '–', twd.std != null ? '±' + n(toDeg(twd.std)) : '')}
      ${twaAwa}
      ${cell(n(toDeg(heel.mean)), `${n(toDeg(heel.p10))}–${n(toDeg(heel.p90))}`)}
    </tr>`
  }).join('')

  const events = (data.events || []).map((e, i) => `
    <li class="ev-item" data-idx="${i}">
        <span class="ev-time">${fmtTime(e.time)}</span>
        <span class="ev-${e.type}">${e.type === 'tack' ? t('tack') : t('gybe')}</span>
        <button class="ev-del" data-event="${e.id}" title="${t('removeManeuver')}">×</button></li>`).join('')

  const tacks = (data.events || []).filter((e) => e.type === 'tack').length
  const gybes = (data.events || []).filter((e) => e.type === 'gybe').length

  el.innerHTML = `
    <h2>${escapeHtml(placeOf(tr, 'start') || t('unknown'))} → ${escapeHtml(placeOf(tr, 'stop') || t('unknown'))}</h2>
    <p class="meta">${fmtDate(tr.start_time)} · ${fmtTime(tr.start_time)}–${fmtTime(tr.stop_time)}
       · ${fmtDuration(tr.start_time, tr.stop_time)}
       ${tr.distance_nm != null ? '· ' + n(tr.distance_nm, 1) + ' NM' : ''}
       ${tr.max_sog != null ? '· max ' + n(toKnots(tr.max_sog), 1) + ' kn' : ''}
       ${engineFrag(tr)}
       ${tr.motor ? `· <span class="tag">${t('motor')}</span>` : ''}
       ${tr.origin === 'retro' ? '· <em>retro</em>' : ''}</p>

    <div id="trackmap" class="trackmap" hidden></div>

    <div class="places">
      ${tr.same_place
        ? `<label>${t('place')}
            <input type="text" id="start-place" value="${escapeAttr(placeOf(tr, 'start'))}"
                   placeholder="${escapeAttr(tr.start_place || '')}"></label>`
        : `<label>${t('startPlace')}
            <input type="text" id="start-place" value="${escapeAttr(placeOf(tr, 'start'))}"
                   placeholder="${escapeAttr(tr.start_place || '')}"></label>
          <label>${t('endPlace')}
            <input type="text" id="stop-place" value="${escapeAttr(placeOf(tr, 'stop'))}"
                   placeholder="${escapeAttr(tr.stop_place || '')}"></label>`}
      <button id="save-places">${t('savePlaces')}</button>
    </div>
    <p class="hint place-hint">${t('placeHint')}</p>

    <div class="weather">
      <h3>${t('hourlyWeather')}</h3>
      ${rows ? `<div class="table-scroll"><table class="hourly">
        <thead><tr>
          <th>${t('hr')}</th>
          <th class="num">STW<br><small>kn</small></th>
          <th class="num">TWS<br><small>m/s</small></th>
          <th class="num">TWD<br><small>°</small></th>
          <th class="num">TWA<br><small>°</small></th>
          <th class="num">AWA<br><small>°</small></th>
          <th class="num">${t('heel')}<br><small>°</small></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="unit-note">${t('unitNote')}</p>`
        : `<p class="hint">${t('noWeather')}</p>`}
    </div>

    <div class="events">
      <h3 class="ev-summary">${maneuverSummary(gybes, tacks)}</h3>
      ${events ? `<ul class="ev-list">${events}</ul>` : ''}
    </div>

    <div class="actions">
      <button id="copy-report">${t('copyReport')}</button>
      <button id="delete-trip" class="danger">${t('deleteTrip')}</button>
    </div>
    <pre id="report-preview" class="report" hidden></pre>`

  // Remember which sides currently have a named (registry) place, so emptying one
  // and saving is understood as a delete rather than a no-op.
  const named = { start: tr.start_place_manual != null, stop: tr.stop_place_manual != null }
  $('#save-places').addEventListener('click', () => savePlaces(tr.id, named))
  $('#copy-report').addEventListener('click', () => copyReport(tr.id))
  $('#delete-trip').addEventListener('click', () => deleteTrip(tr.id))
  document.querySelectorAll('.ev-del').forEach((b) => {
    b.addEventListener('click', () => deleteEvent(b.getAttribute('data-event'), tr.id))
  })
  // Clicking a maneuver row marks that moment on the track (except when the
  // click was on its delete button).
  document.querySelectorAll('.ev-item').forEach((li) => {
    li.addEventListener('click', (ev) => {
      if (ev.target.closest('.ev-del')) {
        return
      }
      showManeuverOnTrack(data.events[parseInt(li.getAttribute('data-idx'), 10)])
    })
  })

  renderTrack(tr.id, data.events || [])
}

// Understated maneuver summary used as the section's only heading, e.g.
// "2 gybes and 3 tacks", "1 gybe" or "No gybes or tacks".
function maneuverSummary (gybes, tacks) {
  if (!gybes && !tacks) {
    return t('noManeuvers')
  }
  const parts = []
  if (gybes) {
    parts.push(`${gybes} ${gybes === 1 ? t('gybeSing') : t('gybePlur')}`)
  }
  if (tacks) {
    parts.push(`${tacks} ${tacks === 1 ? t('tackSing') : t('tackPlur')}`)
  }
  return parts.join(` ${t('andWord')} `)
}

// ---- track map -----------------------------------------------------------

// Colour a track segment by boat speed: dark purple (slow) → bright orange
// (fast). Hue stays in the warm purple–red–orange band that avoids the blue
// water and green land of the base map, while lightness rises with speed so the
// variation reads clearly (hue alone within a narrow band was near-invisible).
// A segment whose SOG is unknown gets a neutral grey.
function sogColor (v, lo, hi) {
  if (v == null) {
    return '#888'
  }
  const f = hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0.5
  const hue = (300 + 95 * f) % 360 // 300 purple → 360 red → 35 orange
  const light = 34 + 24 * f // dark (slow) → bright (fast)
  return `hsl(${Math.round(hue)}, 92%, ${Math.round(light)}%)`
}

function cssVar (name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

// The track point geographically closest to a clicked map location.
function nearestPoint (map, latlng, points) {
  let best = null
  let bd = Infinity
  for (const p of points) {
    const d = map.distance(latlng, [p.lat, p.lon])
    if (d < bd) {
      bd = d
      best = p
    }
  }
  return best
}

// A moment's conditions for the click popup: time, then speeds, wind, pointing
// angles and heel — only the fields that actually have a value.
function snapContent (p) {
  const rows = []
  const speed = []
  if (p.sog != null) {
    speed.push(`SOG ${n(toKnots(p.sog), 1)} kn`)
  }
  if (p.stw != null) {
    speed.push(`STW ${n(toKnots(p.stw), 1)} kn`)
  }
  if (speed.length) {
    rows.push(speed.join(' · '))
  }
  const wind = []
  if (p.tws != null) {
    wind.push(`TWS ${n(p.tws, 1)} m/s`)
  }
  if (p.twd != null) {
    wind.push(`TWD ${n((toDeg(p.twd) + 360) % 360)}°`)
  }
  if (wind.length) {
    rows.push(wind.join(' · '))
  }
  const angle = []
  if (p.twa != null) {
    angle.push(`TWA ${n(Math.abs(toDeg(p.twa)))}°${sideLetter(p.twa)}`)
  }
  if (p.awa != null) {
    angle.push(`AWA ${n(Math.abs(toDeg(p.awa)))}°${sideLetter(p.awa)}`)
  }
  if (angle.length) {
    rows.push(angle.join(' · '))
  }
  if (p.heel != null) {
    rows.push(`${t('heel')} ${n(Math.abs(toDeg(p.heel)))}°`)
  }
  return `<div class="snap"><strong>${fmtTime(p.t)}</strong>${rows.map((r) => `<span>${r}</span>`).join('')}</div>`
}

// From a maneuver-row click: locate the moment on the track (the point nearest
// in time), scroll the map into view, pan there and open its snapshot popup.
function showManeuverOnTrack (ev) {
  if (!ev || !trackMap || !trackPoints.length) {
    return
  }
  let best = null
  let bd = Infinity
  for (const p of trackPoints) {
    const d = Math.abs(p.t - ev.time)
    if (d < bd) {
      bd = d
      best = p
    }
  }
  if (!best) {
    return
  }
  trackMap.getContainer().scrollIntoView({ behavior: 'smooth', block: 'center' })
  trackMap.panTo([best.lat, best.lon])
  L.popup().setLatLng([best.lat, best.lon]).setContent(snapContent(best)).openOn(trackMap)
}

// Fetch the downsampled position+SOG track and draw it on a Leaflet map with an
// OSM base and the OpenSeaMap seamark overlay. Tiles need the network; offline
// they simply don't load and the speed-coloured track shows on a blank canvas.
// A trip with fewer than two points (no logged position) hides the map.
async function renderTrack (id, events) {
  const host = document.getElementById('trackmap')
  if (!host || typeof L === 'undefined') {
    return
  }
  if (trackMap) {
    trackMap.remove()
    trackMap = null
    trackPoints = []
  }
  let points
  try {
    points = (await getJSON(`${READ}/trips/${id}/track`)).points || []
  } catch (e) {
    return
  }
  // A fast back-and-forth to another trip may have replaced #detail while the
  // track was in flight; the captured host is then detached, so bail.
  if (!host.isConnected || points.length < 2) {
    return
  }

  try {
    drawTrack(host, points, events)
  } catch (e) {
    // Never let a map failure bubble as an unhandled rejection.
  }
}

function drawTrack (host, points, events) {
  host.hidden = false

  const map = L.map(host, { zoomControl: true })
  trackMap = map
  trackPoints = points
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map)
  L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© OpenSeaMap'
  }).addTo(map)

  const sogs = points.map((p) => p.sog).filter((s) => s != null)
  const lo = sogs.length ? Math.min(...sogs) : 0
  const hi = sogs.length ? Math.max(...sogs) : 0
  const latlngs = points.map((p) => [p.lat, p.lon])

  // A white casing under the whole track guarantees the thin coloured line
  // separates from any tile background (land, water or forest).
  L.polyline(latlngs, { color: '#fff', weight: 6, opacity: 0.7 }).addTo(map)

  // One short polyline per step, coloured by the mean speed of its two ends, so
  // the whole track reads as a speed heat-line.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const s = a.sog != null && b.sog != null ? (a.sog + b.sog) / 2 : (a.sog != null ? a.sog : b.sog)
    L.polyline([latlngs[i - 1], latlngs[i]], {
      color: sogColor(s, lo, hi),
      weight: 3,
      opacity: 0.9
    }).addTo(map)
  }

  // A fat transparent line over the whole track gives a comfortable click/tap
  // target (the coloured line is thin, awkward to hit on touch). Clicking it
  // opens a popup with the nearest point's snapshot, like a maneuver marker.
  L.polyline(latlngs, { color: '#000', opacity: 0.01, weight: 16 })
    .addTo(map)
    .on('click', (e) => {
      const p = nearestPoint(map, e.latlng, points)
      if (p) {
        L.popup().setLatLng([p.lat, p.lon]).setContent(snapContent(p)).openOn(map)
      }
    })

  // Tacks and gybes as small dots in their report colours.
  const tackColor = cssVar('--tack', '#2a7d4f')
  const gybeColor = cssVar('--gybe', '#b4682a')
  events.forEach((e) => {
    if (e.lat == null || e.lon == null) {
      return
    }
    L.circleMarker([e.lat, e.lon], {
      radius: 4,
      color: '#fff',
      weight: 1,
      fillColor: e.type === 'gybe' ? gybeColor : tackColor,
      fillOpacity: 1
    }).addTo(map).bindTooltip(`${e.type === 'tack' ? t('tack') : t('gybe')} · ${fmtTime(e.time)}`)
  })

  // Start and end, larger and ringed so they stand out from the heat-line.
  const endDot = (ll, color) => L.circleMarker(ll, {
    radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1
  }).addTo(map)
  endDot(latlngs[0], cssVar('--tack', '#2a7d4f'))
  endDot(latlngs[latlngs.length - 1], cssVar('--danger', '#b23b3b'))

  map.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24] })

  // Speed legend (purple→orange gradient with the min/max in knots).
  if (sogs.length) {
    const legend = L.control({ position: 'bottomleft' })
    legend.onAdd = () => {
      const div = L.DomUtil.create('div', 'track-legend')
      const stops = []
      for (let i = 0; i <= 6; i++) {
        stops.push(sogColor(lo + ((hi - lo) * i) / 6, lo, hi))
      }
      div.innerHTML =
        `<span class="tl-label">${t('speed')}</span>` +
        `<span class="tl-label">${n(toKnots(lo), 1)}</span>` +
        `<span class="tl-bar" style="background:linear-gradient(to right,${stops.join(',')})"></span>` +
        `<span class="tl-label">${n(toKnots(hi), 1)} kn</span>`
      return div
    }
    legend.addTo(map)
  }
}

async function deleteEvent (eventId, tripId) {
  try {
    const r = await fetch(`${ADMIN}/events/${eventId}`, { method: 'DELETE' })
    if (r.status === 401 || r.status === 403) {
      throw new Error(t('adminLogin'))
    }
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`)
    }
    loadDetail(tripId)
  } catch (e) {
    setStatus(t('couldNotRemove') + e.message, true)
  }
}

async function savePlaces (id, named) {
  const start = $('#start-place').value.trim()
  // A round trip (same_place) renders one field and no #stop-place input.
  const stopEl = $('#stop-place')
  const stop = stopEl ? stopEl.value.trim() : null
  // Emptying a field that held a named place means "remove that place". Confirm
  // once, since the name is shared with every trip near it.
  const dels = []
  if (named.start && !start) {
    dels.push('start')
  }
  if (stopEl && named.stop && !stop) {
    dels.push('stop')
  }
  if (dels.length && !window.confirm(t('confirmDeletePlace'))) {
    return
  }
  const guard = (r) => {
    if (r.status === 401 || r.status === 403) {
      throw new Error(t('adminLogin'))
    }
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`)
    }
  }
  try {
    for (const side of dels) {
      guard(await fetch(`${ADMIN}/trips/${id}/place/${side}`, { method: 'DELETE' }))
    }
    // Creates/renames; empty fields are no-ops server-side. Omit stopPlace for a
    // round trip so the single field drives the one shared place.
    const body = { startPlace: start || null }
    if (stopEl) {
      body.stopPlace = stop || null
    }
    guard(await fetch(`${ADMIN}/trips/${id}/place`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }))
    setStatus(t('placesSaved'))
    loadDetail(id)
  } catch (e) {
    setStatus(t('couldNotSave') + e.message, true)
  }
}

async function copyReport (id) {
  try {
    const r = await fetch(`${READ}/trips/${id}/report?lang=${LANG}`)
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`)
    }
    const text = await r.text()
    const pre = $('#report-preview')
    pre.textContent = text
    pre.hidden = false
    try {
      await navigator.clipboard.writeText(text)
      setStatus(t('copied'))
    } catch (e) {
      setStatus(t('copyManually'), true)
    }
  } catch (e) {
    setStatus(t('couldNotFetchReport') + e.message, true)
  }
}

async function deleteTrip (id) {
  if (!window.confirm(t('confirmDeleteTrip'))) {
    return
  }
  try {
    const r = await fetch(`${ADMIN}/trips/${id}`, { method: 'DELETE' })
    if (r.status === 401 || r.status === 403) {
      throw new Error(t('adminLogin'))
    }
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`)
    }
    loadList()
  } catch (e) {
    setStatus(t('couldNotDelete') + e.message, true)
  }
}

// ---- retro scan ----------------------------------------------------------

async function runScan () {
  const fromStr = $('#scan-from').value
  const toStr = $('#scan-to').value
  if (!fromStr || !toStr) {
    setStatus(t('pickDates'), true)
    return
  }
  const from = new Date(fromStr + 'T00:00:00').getTime()
  const to = new Date(toStr + 'T23:59:59').getTime()
  $('#scan-result').textContent = t('scanning')
  try {
    const r = await fetch(`${ADMIN}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to })
    })
    if (r.status === 401 || r.status === 403) {
      throw new Error(t('adminLogin'))
    }
    const data = await r.json()
    if (!r.ok) {
      throw new Error(data.error || `HTTP ${r.status}`)
    }
    $('#scan-result').textContent = t('scanDone')(data.created, data.segments, data.scanned)
    loadList()
  } catch (e) {
    $('#scan-result').textContent = t('error') + e.message
  }
}

// ---- helpers -------------------------------------------------------------

function showView (which) {
  $('#list-view').hidden = which !== 'list'
  $('#detail-view').hidden = which !== 'detail'
  // Tear the map down when leaving the detail, so its tile layers and timers
  // don't linger in the hidden view.
  if (which !== 'detail' && trackMap) {
    trackMap.remove()
    trackMap = null
    trackPoints = []
  }
}

function escapeHtml (s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}
function escapeAttr (s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

// Fill static [data-i18n] elements and page metadata for the chosen language.
function applyStatic () {
  document.documentElement.lang = LANG
  document.title = t('title')
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'))
  })
}

$('#back-btn').addEventListener('click', loadList)
$('#scan-btn').addEventListener('click', runScan)
applyStatic()
loadList()
