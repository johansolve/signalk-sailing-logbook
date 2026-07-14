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
    startPlace: 'Start place', endPlace: 'End place', savePlaces: 'Save places',
    hourlyWeather: 'Hourly weather', hr: 'Hr', heel: 'Heel',
    unitNote: 'Mean with p10–p90 range; TWA/AWA show the dominant side (S/P); TWD is the circular mean with ±angular deviation.',
    noWeather: 'No weather statistics (trip has no end time or no data).',
    maneuvers: 'Maneuvers', tacks: 'tacks', gybes: 'gybes', tack: 'Tack', gybe: 'Gybe',
    noneRecorded: 'None recorded.', copyReport: 'Copy logbook entry', deleteTrip: 'Delete trip',
    removeManeuver: 'Remove this maneuver', stbd: 'S', port: 'P', motor: 'motor',
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
    startPlace: 'Startplats', endPlace: 'Slutplats', savePlaces: 'Spara platser',
    hourlyWeather: 'Timväder', hr: 'Tim', heel: 'Kräng',
    unitNote: 'Medel med p10–p90-intervall; TWA/AWA visar dominerande sida (SB/BB); TWD är cirkulärt medel med ±vinkelavvikelse.',
    noWeather: 'Ingen väderstatistik (tripen saknar sluttid eller data).',
    maneuvers: 'Manövrar', tacks: 'slag', gybes: 'gippar', tack: 'Slag', gybe: 'Gipp',
    noneRecorded: 'Inga registrerade.', copyReport: 'Kopiera loggbokstext', deleteTrip: 'Ta bort trip',
    removeManeuver: 'Ta bort manövern', stbd: 'SB', port: 'BB', motor: 'motor',
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
    return `<tr>
      <td>${fmtTime(h.time)}</td>
      ${cell(n(tws.mean, 1), `${n(tws.p10, 1)}–${n(tws.p90, 1)}`)}
      ${cell(n(toKnots(stw.mean), 1), `${n(toKnots(stw.p10), 1)}–${n(toKnots(stw.p90), 1)}`)}
      ${cell(twd.mean != null ? n(toDeg(twd.mean)) : '–', twd.std != null ? '±' + n(toDeg(twd.std)) : '')}
      ${cell(n(toDeg(twa.mean)) + sideLetter(twa.side), `${n(toDeg(twa.p10))}–${n(toDeg(twa.p90))}`)}
      ${cell(n(toDeg(awa.mean)) + sideLetter(awa.side), `${n(toDeg(awa.p10))}–${n(toDeg(awa.p90))}`)}
      ${cell(n(toDeg(heel.mean)), `${n(toDeg(heel.p10))}–${n(toDeg(heel.p90))}`)}
    </tr>`
  }).join('')

  const events = (data.events || []).map((e) => `
    <li><span class="ev-time">${fmtTime(e.time)}</span>
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
       ${tr.motor ? `· <span class="tag">${t('motor')}</span>` : ''}
       ${tr.origin === 'retro' ? '· <em>retro</em>' : ''}</p>

    <div class="places">
      <label>${t('startPlace')}
        <input type="text" id="start-place" value="${escapeAttr(placeOf(tr, 'start'))}"
               placeholder="${escapeAttr(tr.start_place || '')}"></label>
      <label>${t('endPlace')}
        <input type="text" id="stop-place" value="${escapeAttr(placeOf(tr, 'stop'))}"
               placeholder="${escapeAttr(tr.stop_place || '')}"></label>
      <button id="save-places">${t('savePlaces')}</button>
    </div>

    <div class="detail-cols">
      <div class="weather">
        <h3>${t('hourlyWeather')}</h3>
        ${rows ? `<div class="table-scroll"><table class="hourly">
          <thead><tr>
            <th>${t('hr')}</th>
            <th class="num">TWS<br><small>m/s</small></th>
            <th class="num">STW<br><small>kn</small></th>
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
        <h3>${t('maneuvers')} (${tacks} ${t('tacks')}, ${gybes} ${t('gybes')})</h3>
        <ul class="ev-list">${events || `<li class="hint">${t('noneRecorded')}</li>`}</ul>
      </div>
    </div>

    <div class="actions">
      <button id="copy-report">${t('copyReport')}</button>
      <button id="delete-trip" class="danger">${t('deleteTrip')}</button>
    </div>
    <pre id="report-preview" class="report" hidden></pre>`

  $('#save-places').addEventListener('click', () => savePlaces(tr.id))
  $('#copy-report').addEventListener('click', () => copyReport(tr.id))
  $('#delete-trip').addEventListener('click', () => deleteTrip(tr.id))
  document.querySelectorAll('.ev-del').forEach((b) => {
    b.addEventListener('click', () => deleteEvent(b.getAttribute('data-event'), tr.id))
  })
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

async function savePlaces (id) {
  const body = {
    startPlace: $('#start-place').value.trim() || null,
    stopPlace: $('#stop-place').value.trim() || null
  }
  try {
    const r = await fetch(`${ADMIN}/trips/${id}/place`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (r.status === 401 || r.status === 403) {
      throw new Error(t('adminLogin'))
    }
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`)
    }
    setStatus(t('placesSaved'))
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
