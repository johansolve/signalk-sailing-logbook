'use strict'

// Read endpoints (anonymous, honour "allow readonly access").
const READ = '/signalk/v1/api/sailing-logbook'
// Write/scan endpoints (admin-guarded by the server).
const ADMIN = '/plugins/signalk-sailing-logbook'

// ---- i18n ----------------------------------------------------------------
// Language: ?lang= override, else browser preference, else English. Adding a
// language is data-driven: drop in a string set below (with its `locale`, and
// `pctSpace: true` if the language puts a space before the percent sign) and the
// ?lang override and browser detection pick it up. The report is localised
// separately in plugin/lib/report.js.
const STR = {
  en: {
    locale: 'en-GB',
    title: 'Logbook', scanHistory: 'Scan history',
    scanHint: 'Scans the InfluxDB history and creates any trips that are missing. Overlapping trips are skipped. Requires admin login.',
    from: 'From', to: 'To', scan: 'Scan',
    date: 'Date', route: 'From → To', duration: 'Duration', distance: 'Distance', max: 'Max', tacksGybes: 'Tacks/Gybes',
    noTrips: 'No trips yet. Go sailing, or scan the history above.', back: '← Back',
    allYears: 'All',
    seasonTrips: 'Trips', seasonDistance: 'Distance', seasonTime: 'Time',
    seasonManeuvers: 'Tacks/Gybes', seasonMotor: 'Under engine',
    playback: 'Play back a passage',
    playbackHint: 'Replays the trips between two dates on the map, the boat drawing its track as it goes and pausing briefly in each port.',
    playbackStart: 'Play', play: 'Play', pause: 'Pause', replay: 'Replay',
    tripMeter: 'Trip', inPort: 'in port', overnight: 'overnight',
    playbackEmpty: 'No trips between those dates.',
    playbackNoTrack: 'None of those trips has a logged track.',
    playbackDone: 'Playback finished.', loadingTrack: 'Loading track…',
    playbackNoMap: 'The map library did not load.',
    underWay: '(under way)', loading: 'Loading…', unknown: 'Unknown',
    startPlace: 'Start place', endPlace: 'End place', place: 'Place', savePlaces: 'Save places',
    placeHint: 'A named place is reused for every trip starting or ending within a 250 m radius. Clear a field and save to remove its name.',
    confirmDeletePlace: 'Remove this place name? Every trip near it reverts to the looked-up name.',
    notes: 'Notes', saveNotes: 'Save notes', notesSaved: 'Notes saved',
    notesPlaceholder: 'Your own notes for this trip…',
    speed: 'Speed', time: 'Time', timeline: 'Timeline', dragToResize: 'Drag to resize the map',
    hourlyWeather: 'Hourly weather', hr: 'Hr', heel: 'Heel',
    unitNote: 'Mean with p10–p90 range; TWA/AWA show the dominant side (S/P); TWD is the circular mean with ±angular deviation.',
    noWeather: 'No weather statistics (trip has no end time or no data).',
    tack: 'Tack', gybe: 'Gybe',
    gybeSing: 'gybe', gybePlur: 'gybes', tackSing: 'tack', tackPlur: 'tacks',
    andWord: 'and', noManeuvers: 'No gybes or tacks',
    copyReport: 'Show logbook entry', copy: 'Copy', deleteTrip: 'Delete trip',
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
    locale: 'sv-SE', pctSpace: true,
    title: 'Loggbok', scanHistory: 'Skanna historik',
    scanHint: 'Skannar InfluxDB-historiken och skapar trips som saknas. Överlappande trips hoppas över. Kräver admin-inloggning.',
    from: 'Från', to: 'Till', scan: 'Skanna',
    date: 'Datum', route: 'Från → Till', duration: 'Restid', distance: 'Distans', max: 'Max', tacksGybes: 'Slag/Gipp',
    noTrips: 'Inga trips än. Segla, eller skanna historiken ovan.', back: '← Tillbaka',
    allYears: 'Alla',
    seasonTrips: 'Trips', seasonDistance: 'Distans', seasonTime: 'Tid',
    seasonManeuvers: 'Slag/Gipp', seasonMotor: 'För motor',
    playback: 'Spela upp en seglats',
    playbackHint: 'Spelar upp tripsen mellan två datum på kartan, båten ritar sitt spår efter sig och stannar till i varje hamn.',
    playbackStart: 'Spela upp', play: 'Spela', pause: 'Pausa', replay: 'Spela om',
    tripMeter: 'Trip', inPort: 'i hamn', overnight: 'övernattning',
    playbackEmpty: 'Inga trips mellan de datumen.',
    playbackNoTrack: 'Ingen av tripsen har något loggat spår.',
    playbackDone: 'Uppspelningen är klar.', loadingTrack: 'Hämtar spår…',
    playbackNoMap: 'Kartbiblioteket kunde inte laddas.',
    underWay: '(pågår)', loading: 'Laddar…', unknown: 'Okänd',
    startPlace: 'Startplats', endPlace: 'Slutplats', place: 'Plats', savePlaces: 'Spara platser',
    placeHint: 'Ett platsnamn återanvänds för alla trips som startar eller slutar inom 250 m radie. Töm ett fält och spara för att ta bort namnet.',
    confirmDeletePlace: 'Ta bort platsnamnet? Alla trips nära det återgår till det uppslagna namnet.',
    notes: 'Anteckningar', saveNotes: 'Spara anteckningar', notesSaved: 'Anteckningar sparade',
    notesPlaceholder: 'Egna anteckningar för den här tripen…',
    speed: 'Fart', time: 'Tid', timeline: 'Tidslinje', dragToResize: 'Dra för att ändra kartans storlek',
    hourlyWeather: 'Timväder', hr: 'Tim', heel: 'Kräng',
    unitNote: 'Medel med p10–p90-intervall; TWA/AWA visar dominerande sida (SB/BB); TWD är cirkulärt medel med ±vinkelavvikelse.',
    noWeather: 'Ingen väderstatistik (tripen saknar sluttid eller data).',
    tack: 'Slag', gybe: 'Gipp',
    gybeSing: 'gipp', gybePlur: 'gippar', tackSing: 'slag', tackPlur: 'slag',
    andWord: 'och', noManeuvers: 'Inga gippar eller slag',
    copyReport: 'Visa loggbokstext', copy: 'Kopiera', deleteTrip: 'Ta bort trip',
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
const LOCALE = STR[LANG].locale || LANG
const t = (k) => STR[LANG][k]

const MS_PER_KNOT = 0.514444
const RAD = 180 / Math.PI

const $ = (sel) => document.querySelector(sel)

// The one live Leaflet map, torn down and rebuilt each time a detail is opened,
// plus its track points so a maneuver-row click can locate the moment on it.
let trackMap = null
let trackPoints = []
// The moving highlight marker driven by the timeline scrubber, the events keyed
// by the track index nearest each in time (so scrubbing onto one shows its
// label), and the info-panel columns present for this trip (fixed for its whole
// length so scrubbing never adds or drops a cell).
let scrubDot = null
let scrubEvents = null
let scrubFields = []
let scrubHasMotor = false
// The trip whose detail is currently open, so a late async response (hourly
// stats) for a trip we've navigated away from can be dropped.
let currentDetailId = null

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
  // Some languages put a space before the percent sign (Swedish); a language
  // opts in with pctSpace in its string set, otherwise the compact form is used.
  return STR[LANG].pctSpace ? `${n(v)} %` : `${n(v)}%`
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

// Every trip the server has, kept here so switching year is a client-side slice
// with no round-trip. A trip is ~500 bytes, so a decade of sailing is a couple
// of hundred kB; revisit if a logbook ever runs to thousands of trips.
let allTrips = []
let currentYear = null

const yearOf = (tr) => new Date(tr.start_time).getFullYear()
const yearsOf = (trips) => [...new Set(trips.map(yearOf))].sort((a, b) => b - a)

async function loadList () {
  showView('list')
  try {
    allTrips = await getJSON(`${READ}/trips`)
    selectYear(initialYear(yearsOf(allTrips)))
    setStatus('')
  } catch (e) {
    setStatus(t('couldNotLoadTrips') + e.message, true)
  }
}

// ?year=2027 (or ?year=all) wins, so a season is linkable; otherwise the most
// recent year that actually has trips. Defaulting to the calendar year instead
// would open on an empty list every winter, which is most of the year up here.
function initialYear (years) {
  const forced = new URLSearchParams(location.search).get('year')
  if (forced === 'all') {
    return 'all'
  }
  if (years.includes(Number(forced))) {
    return Number(forced)
  }
  return years.length ? years[0] : 'all'
}

function selectYear (year) {
  currentYear = year
  const trips = year === 'all' ? allTrips : allTrips.filter((tr) => yearOf(tr) === year)
  renderYears(yearsOf(allTrips))
  renderSeason(trips)
  renderList(trips)
  pbDefaultDates(trips)
  // Keep the chosen year in the URL (without a reload) so it survives the trip
  // detail and back, and can be shared. Any other param, ?lang, is preserved.
  const q = new URLSearchParams(location.search)
  q.set('year', String(year))
  history.replaceState(null, '', `${location.pathname}?${q}`)
}

// One chip per year with trips, newest first, plus "All". Hidden while a single
// season is all there is, so a new logbook isn't cluttered by a filter of one.
function renderYears (years) {
  const box = $('#year-filter')
  box.hidden = years.length < 2
  box.innerHTML = ''
  if (box.hidden) {
    return
  }
  const add = (value, label) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'year-chip' + (value === currentYear ? ' on' : '')
    b.textContent = label
    b.addEventListener('click', () => selectYear(value))
    box.appendChild(b)
  }
  years.forEach((y) => add(y, String(y)))
  add('all', t('allYears'))
}

// Season totals for whatever is in view. Motoring is only shown when the engine
// actually ran, so a pure sailing season doesn't carry a "0m" cell.
function renderSeason (trips) {
  const box = $('#season-sum')
  box.hidden = !trips.length
  box.innerHTML = ''
  if (box.hidden) {
    return
  }
  let nm = 0
  let ms = 0
  let motorMs = 0
  // Time of the trips whose engine share is known, so a trip still under way
  // (share computed only once it ends) doesn't dilute the motoring percentage.
  let ratedMs = 0
  let tacks = 0
  let gybes = 0
  const now = Date.now()
  trips.forEach((tr) => {
    nm += tr.distance_nm || 0
    tacks += tr.tack || 0
    gybes += tr.gybe || 0
    // A trip under way counts its elapsed time, so every cell describes the
    // same set of trips.
    const d = (tr.stop_time == null ? now : tr.stop_time) - tr.start_time
    ms += d
    if (tr.engine_share != null) {
      ratedMs += d
      motorMs += d * tr.engine_share
    }
  })
  const cells = [
    [t('seasonTrips'), String(trips.length)],
    [t('seasonDistance'), `${n(nm, 1)} NM`],
    [t('seasonTime'), fmtDuration(0, ms)],
    [t('seasonManeuvers'), `${tacks}/${gybes}`]
  ]
  if (motorMs > 60000 && ratedMs > 0) {
    cells.push([t('seasonMotor'), `${fmtDuration(0, motorMs)} (${pct((motorMs / ratedMs) * 100)})`])
  }
  box.innerHTML = cells
    .map(([k, v]) => `<div class="ss-cell"><span class="ss-k">${k}</span><span class="ss-v">${escapeHtml(v)}</span></div>`)
    .join('')
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
      <td class="num">${tr.max_stw != null ? n(toKnots(tr.max_stw), 1) + ' kn' : '–'}</td>
      <td class="num">${tr.tack || 0}/${tr.gybe || 0}</td>`
    row.addEventListener('click', () => loadDetail(tr.id))
    tbody.appendChild(row)
  })
}

// Point the playback range at the season in view, so opening the panel offers
// that whole season and a shorter cruise is a matter of pulling the dates in.
// Local date parts, not toISOString, which would shift a summer evening a day.
function pbDefaultDates (trips) {
  if (!trips.length) {
    return
  }
  const iso = (ms) => {
    const d = new Date(ms)
    const p = (v) => String(v).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const times = trips.map((tr) => tr.start_time)
  $('#pb-from').value = iso(Math.min(...times))
  $('#pb-to').value = iso(Math.max(...times))
}

// ---- detail view ---------------------------------------------------------

async function loadDetail (id) {
  showView('detail')
  currentDetailId = id
  $('#detail').innerHTML = `<p class="hint">${t('loading')}</p>`
  try {
    // The cheap part (trip row + maneuvers, straight from SQLite) renders the
    // header, map and controls at once; the expensive hourly stats and the track
    // load separately so the page isn't held up by either.
    const data = await getJSON(`${READ}/trips/${id}`)
    renderDetail(data)
    setStatus('')
    loadHourly(id)
  } catch (e) {
    $('#detail').innerHTML = ''
    setStatus(t('couldNotLoadTrip') + e.message, true)
  }
}

// Load the hourly stats separately and fill the weather table when they arrive.
// A late response for a trip we've since navigated away from is dropped.
async function loadHourly (id) {
  let hourly = []
  try {
    hourly = (await getJSON(`${READ}/trips/${id}/hourly`)).hourly || []
  } catch (e) {
    hourly = []
  }
  if (id === currentDetailId) {
    fillHourly(hourly)
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
       ${tr.max_stw != null ? '· max ' + n(toKnots(tr.max_stw), 1) + ' kn' : ''}
       ${engineFrag(tr)}
       ${tr.motor ? `· <span class="tag">${t('motor')}</span>` : ''}
       ${tr.origin === 'retro' ? '· <em>retro</em>' : ''}</p>

    <!-- Shown from the start (its water backdrop is a placeholder) so the map's
         height is reserved at load and the content below doesn't jump when the
         async track resolves. renderTrack hides it only if the trip has no track. -->
    <div id="trackmap" class="trackmap"></div>
    <div id="map-resize" class="map-resize" title="${t('dragToResize')}" hidden></div>
    <div id="track-info" class="track-info" hidden></div>
    <div id="track-scrub" class="track-scrub" hidden>
      <div id="scrub-ticks" class="scrub-ticks"></div>
      <input type="range" id="scrub" class="scrub" min="0" max="0" step="1" value="0"
             aria-label="${t('timeline')}">
      <div class="scrub-times"><span id="scrub-start"></span><span id="scrub-end"></span></div>
    </div>

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

    <details class="notes"${tr.notes ? ' open' : ''}>
      <summary>${t('notes')}</summary>
      <div class="notes-body">
        <textarea id="trip-notes" class="notes-field" rows="6"
                  placeholder="${escapeAttr(t('notesPlaceholder'))}">${escapeHtml(tr.notes || '')}</textarea>
        <button id="save-notes">${t('saveNotes')}</button>
      </div>
    </details>

    <div class="weather">
      <h3>${t('hourlyWeather')}</h3>
      <div id="hourly-body"><p class="hint">${t('loading')}</p></div>
    </div>

    <div class="events">
      <h3 class="ev-summary">${maneuverSummary(gybes, tacks)}</h3>
      ${events ? `<ul class="ev-list">${events}</ul>` : ''}
    </div>

    <div class="actions">
      <button id="copy-report">${t('copyReport')}</button>
      <button id="delete-trip" class="danger">${t('deleteTrip')}</button>
    </div>
    <div id="report-wrap" class="report-wrap" hidden>
      <button id="report-copy" class="report-copy">${t('copy')}</button>
      <pre id="report-preview" class="report"></pre>
    </div>`

  // Remember which sides currently have a named (registry) place, so emptying one
  // and saving is understood as a delete rather than a no-op.
  const named = { start: tr.start_place_manual != null, stop: tr.stop_place_manual != null }
  $('#save-places').addEventListener('click', () => savePlaces(tr.id, named))
  $('#save-notes').addEventListener('click', () => saveNotes(tr.id))
  $('#copy-report').addEventListener('click', () => copyReport(tr.id))
  // The report box's own copy button re-copies the shown text (textContent
  // reconstructs the raw report: the nowrap spans and HTML escaping render back
  // to the exact original).
  $('#report-copy').addEventListener('click', () => copyToClipboard($('#report-preview').textContent))
  $('#delete-trip').addEventListener('click', () => deleteTrip(tr.id))
  document.querySelectorAll('.ev-del').forEach((b) => {
    b.addEventListener('click', () => deleteEvent(b.getAttribute('data-event'), tr.id))
  })
  // Clicking a maneuver row scrubs the timeline to that moment and brings the
  // map into view (except when the click was on its delete button).
  document.querySelectorAll('.ev-item').forEach((li) => {
    li.addEventListener('click', (ev) => {
      if (ev.target.closest('.ev-del')) {
        return
      }
      scrubToEvent(data.events[parseInt(li.getAttribute('data-idx'), 10)], true)
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

// Build the hourly weather table rows. Extracted from renderDetail so the stats
// can load and render on their own (see loadHourly), separate from the rest.
function hourlyRowsHtml (hourly) {
  return (hourly || []).map((h) => {
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
}

// Fill the weather section once the hourly stats arrive: the full table, or the
// "no weather" note for a trip with no end or no data.
function fillHourly (hourly) {
  const host = $('#hourly-body')
  if (!host) {
    return
  }
  const rows = hourlyRowsHtml(hourly)
  host.innerHTML = rows
    ? `<div class="table-scroll"><table class="hourly">
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
    : `<p class="hint">${t('noWeather')}</p>`
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

// The track index geographically closest to a clicked map location.
function nearestIndexGeo (map, latlng, points) {
  let best = 0
  let bd = Infinity
  for (let i = 0; i < points.length; i++) {
    const d = map.distance(latlng, [points[i].lat, points[i].lon])
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

// A moment's conditions for the click popup: an optional label (the maneuver
// type), the time, then speeds, wind, pointing angles and heel — only the
// fields that actually have a value.
// The info-panel columns, in order. `label` is a getter (the heel label is
// localised); `fmt` renders a point's value. A column is shown for the whole
// trip if any point has that field (see buildScrubber), with "–" where a given
// point's value is missing, so the layout is fixed while scrubbing.
const INFO_FIELDS = [
  { key: 'sog', label: () => 'SOG', fmt: (p) => `${n(toKnots(p.sog), 1)} kn` },
  { key: 'stw', label: () => 'STW', fmt: (p) => `${n(toKnots(p.stw), 1)} kn` },
  { key: 'tws', label: () => 'TWS', fmt: (p) => `${n(p.tws, 1)} m/s` },
  { key: 'twd', label: () => 'TWD', fmt: (p) => `${n((toDeg(p.twd) + 360) % 360)}°` },
  { key: 'twa', label: () => 'TWA', fmt: (p) => `${n(Math.abs(toDeg(p.twa)))}°${sideLetter(p.twa)}` },
  { key: 'awa', label: () => 'AWA', fmt: (p) => `${n(Math.abs(toDeg(p.awa)))}°${sideLetter(p.awa)}` },
  { key: 'heel', label: () => t('heel'), fmt: (p) => `${n(Math.abs(toDeg(p.heel)))}°` }
]

// One horizontal info-panel cell: a small label over its value.
function infoCell (label, value) {
  return `<span class="ti-cell"><span class="ti-k">${label}</span><span class="ti-v">${value}</span></span>`
}

// The scrubbed moment's conditions, as a row of cells for the fixed panel below
// the map: an optional maneuver label with the time, then the trip's present
// fields (scrubFields), each showing "–" when this point lacks a value.
function infoPanelHtml (p, label) {
  const cells = [infoCell(label ? escapeHtml(label) : t('time'), fmtTime(p.t))]
  scrubFields.forEach((f) => {
    cells.push(infoCell(f.label(), p[f.key] != null ? f.fmt(p) : '–'))
  })
  if (scrubHasMotor) {
    // No header — the badge stands on its own, vertically centred in the column.
    const motor = p.motor ? `<span class="tag">${t('motorHour')}</span>` : '<span class="ti-off">–</span>'
    cells.push(`<span class="ti-cell ti-motor">${motor}</span>`)
  }
  return cells.join('')
}

function maneuverLabel (ev) {
  return ev.type === 'tack' ? t('tack') : t('gybe')
}

// The track index closest in time to a moment (a maneuver).
function nearestIndexByTime (timeMs) {
  let best = 0
  let bd = Infinity
  for (let i = 0; i < trackPoints.length; i++) {
    const d = Math.abs(trackPoints[i].t - timeMs)
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

// Move the timeline (slider, highlight dot and info panel) to a track index.
// `pan` (a list-row click, where the map may be scrolled out of view) also
// brings the map into view and centres it; scrubbing and on-map clicks don't.
function scrubTo (idx, pan) {
  if (!trackMap || !trackPoints.length) {
    return
  }
  idx = Math.max(0, Math.min(trackPoints.length - 1, idx))
  const p = trackPoints[idx]
  const slider = $('#scrub')
  if (slider) {
    slider.value = String(idx)
  }
  if (scrubDot) {
    scrubDot.setLatLng([p.lat, p.lon]).bringToFront()
  }
  const ev = scrubEvents && scrubEvents.get(idx)
  const info = $('#track-info')
  if (info) {
    info.innerHTML = infoPanelHtml(p, ev ? maneuverLabel(ev) : null)
  }
  if (pan) {
    trackMap.getContainer().scrollIntoView({ behavior: 'smooth', block: 'center' })
    trackMap.panTo([p.lat, p.lon])
  }
}

// Scrub to a maneuver by its time.
function scrubToEvent (ev, pan) {
  if (ev) {
    scrubTo(nearestIndexByTime(ev.time), pan)
  }
}

// Fetch the downsampled position+SOG track and draw it on a Leaflet map with an
// OSM base and the OpenSeaMap seamark overlay. Tiles need the network; offline
// they simply don't load and the speed-coloured track shows on a blank canvas.
// A trip with fewer than two points (no logged position) hides the map.
async function renderTrack (id, events) {
  const host = document.getElementById('trackmap')
  if (!host) {
    return
  }
  // Leaflet failed to load: collapse the reserved box, there's nothing to draw.
  if (typeof L === 'undefined') {
    host.hidden = true
    return
  }
  teardownTrack()
  let points
  try {
    points = (await getJSON(`${READ}/trips/${id}/track`)).points || []
  } catch (e) {
    host.hidden = true
    return
  }
  // A fast back-and-forth to another trip may have replaced #detail while the
  // track was in flight; the captured host is then detached, so bail.
  if (!host.isConnected) {
    return
  }
  // No logged position (or a single point): collapse the reserved box so a
  // trackless trip doesn't leave an empty placeholder.
  if (points.length < 2) {
    host.hidden = true
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
  // scrubs the timeline to the nearest point, driving the info panel and dot.
  L.polyline(latlngs, { color: '#000', opacity: 0.01, weight: 16 })
    .addTo(map)
    .on('click', (e) => {
      scrubTo(nearestIndexGeo(map, e.latlng, points), false)
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
    })
      .addTo(map)
      .bindTooltip(`${maneuverLabel(e)} · ${fmtTime(e.time)}`)
      .on('click', () => scrubToEvent(e, false))
  })

  // Start and end, larger and ringed so they stand out from the heat-line.
  const endDot = (ll, color) => L.circleMarker(ll, {
    radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1
  }).addTo(map)
  endDot(latlngs[0], cssVar('--tack', '#2a7d4f'))
  endDot(latlngs[latlngs.length - 1], cssVar('--danger', '#b23b3b'))

  // The moving highlight dot the scrubber drives, drawn on top of everything.
  scrubDot = L.circleMarker(latlngs[0], {
    radius: 8, color: '#fff', weight: 3, fillColor: cssVar('--accent', '#1f6f8b'), fillOpacity: 1
  }).addTo(map)

  map.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24] })

  setupMapResize(host, map)
  buildScrubber(points, events)

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

// A touch- and mouse-friendly drag handle under the map that grows or shrinks
// its height for this view only (CSS resize doesn't work on touch). Leaflet is
// told to re-measure on each move so tiles and the track keep filling the box.
function setupMapResize (host, map) {
  const handle = $('#map-resize')
  if (!handle) {
    return
  }
  handle.hidden = false
  const minH = 220
  const maxH = Math.round(window.innerHeight * 0.9)
  let startY = 0
  let startH = 0
  const onMove = (e) => {
    const h = Math.max(minH, Math.min(maxH, startH + (e.clientY - startY)))
    host.style.height = `${h}px`
    map.invalidateSize({ animate: false })
  }
  const onUp = (e) => {
    if (handle.hasPointerCapture(e.pointerId)) {
      handle.releasePointerCapture(e.pointerId)
    }
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    // A browser-hijacked touch fires pointercancel, not pointerup; clean up on
    // both so a listener never lingers into the next drag.
    handle.removeEventListener('pointercancel', onUp)
  }
  handle.onpointerdown = (e) => {
    startY = e.clientY
    startH = host.getBoundingClientRect().height
    handle.setPointerCapture(e.pointerId)
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
    e.preventDefault()
  }
}

// Wire up the timeline under the map: set the slider's range to the track, mark
// each maneuver both on the slider (a tick) and in a lookup keyed by track index
// (so scrubbing onto one shows its label), reveal the info panel and slider, and
// seed both at the start point.
function buildScrubber (points, events) {
  const slider = $('#scrub')
  const info = $('#track-info')
  const scrub = $('#track-scrub')
  if (!slider || !info || !scrub) {
    return
  }
  const last = points.length - 1
  slider.min = '0'
  slider.max = String(last)
  slider.value = '0'
  $('#scrub-start').textContent = fmtTime(points[0].t)
  $('#scrub-end').textContent = fmtTime(points[last].t)

  // Fix the panel's columns to the fields this trip actually logged, so the
  // cell set never changes as the value scrubs (a field null at one point but
  // present elsewhere still keeps its column, showing "–" where it's missing).
  scrubFields = INFO_FIELDS.filter((f) => points.some((p) => p[f.key] != null))
  // Reserve an engine column only for a trip that ran the engine at all.
  scrubHasMotor = points.some((p) => p.motor)

  // Map each maneuver to its nearest track index (for scrub labels) and lay a
  // tick at that fraction of the slider width.
  scrubEvents = new Map()
  const ticks = $('#scrub-ticks')
  ticks.innerHTML = ''
  events.forEach((e) => {
    const idx = nearestIndexByTime(e.time)
    scrubEvents.set(idx, e)
    const pct = last > 0 ? (idx / last) * 100 : 0
    const tick = document.createElement('span')
    tick.className = `scrub-tick scrub-tick-${e.type}`
    tick.style.left = `${pct}%`
    tick.title = `${maneuverLabel(e)} · ${fmtTime(e.time)}`
    ticks.appendChild(tick)
  })

  slider.oninput = () => scrubTo(parseInt(slider.value, 10), false)
  info.hidden = false
  scrub.hidden = false
  scrubTo(0, false)
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

async function saveNotes (id) {
  const notes = $('#trip-notes').value.trim()
  try {
    const r = await fetch(`${ADMIN}/trips/${id}/notes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notes || null })
    })
    if (r.status === 401 || r.status === 403) {
      throw new Error(t('adminLogin'))
    }
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`)
    }
    setStatus(t('notesSaved'))
    loadDetail(id)
  } catch (e) {
    setStatus(t('couldNotSave') + e.message, true)
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

// Render the report so prose lines wrap within the box while the hourly data
// rows (which start "HH:  " and are column-aligned) stay on one line and scroll.
// The clipboard still gets the raw text, unchanged.
function reportHtml (text) {
  return text.split('\n').map((line) =>
    /^\d{2}:\s/.test(line) ? `<span class="nowrap">${escapeHtml(line)}</span>` : escapeHtml(line)
  ).join('\n')
}

// Write text to the clipboard, reporting success or the manual-copy fallback.
// The Clipboard API needs a secure context (https or localhost); on a plain-http
// LAN address it may be unavailable, so this degrades to the "copy manually"
// hint (the report stays visible in its box for that).
async function copyToClipboard (text) {
  try {
    await navigator.clipboard.writeText(text)
    setStatus(t('copied'))
  } catch (e) {
    setStatus(t('copyManually'), true)
  }
}

async function copyReport (id) {
  try {
    const r = await fetch(`${READ}/trips/${id}/report?lang=${LANG}`)
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`)
    }
    const text = await r.text()
    $('#report-preview').innerHTML = reportHtml(text)
    $('#report-wrap').hidden = false
    copyToClipboard(text)
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

// ---- playback ------------------------------------------------------------

// An hour under way plays in two seconds, so a passage feels long and a harbour
// shuffle feels short; the speed control multiplies this. Between trips the boat
// rests in port — a beat for a lunch stop, longer when it lay there overnight.
const PB_SEC_PER_HOUR = 2
const PB_PORT_PAUSE_MS = 1000
const PB_NIGHT_PAUSE_MS = 2500
const PB_SPEEDS = [0.5, 1, 2, 4]

let pb = null

function pbTeardown () {
  if (!pb) {
    return
  }
  if (pb.raf) {
    cancelAnimationFrame(pb.raf)
  }
  if (pb.map) {
    pb.map.remove()
  }
  pb = null
}

// Start (or restart) the animation loop. The loop stops itself whenever nothing
// is moving — paused or finished — rather than waking 60 times a second to do
// nothing, so resuming has to kick it off again.
function pbLoop () {
  if (!pb) {
    return
  }
  cancelAnimationFrame(pb.raf)
  pb.last = performance.now()
  pb.raf = requestAnimationFrame(pbFrame)
}

// Blank the controls, so a run that ends early (no trips in range, no map) can't
// leave the previous run's chips and clock behind for the user to click.
function pbResetControls () {
  $('#pb-speeds').innerHTML = ''
  $('#pb-toggle').hidden = true
  $('#pb-clock').textContent = ''
  $('#pb-fill').style.width = '0%'
}

// Ground distance between two track points, in metres. Leaflet's own great
// circle distance, so the trip meter agrees with the map rather than with a
// second implementation of the same formula.
function pbLegMeters (map, a, b) {
  return map.distance([a.lat, a.lon], [b.lat, b.lon])
}

// Compass bearing a→b, for pointing the boat symbol where it is heading.
function pbBearing (a, b) {
  const φ1 = (a.lat * Math.PI) / 180
  const φ2 = (b.lat * Math.PI) / 180
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// The pause after a trip: a beat in port, longer if the boat stayed the night.
// Overnight means exactly that, the two trips fall on different calendar days —
// a long lunch stop is still a lunch stop, however many hours it ran to.
function pbPauseAfter (trip, next) {
  if (!next) {
    return 0
  }
  const a = new Date(trip.stop_time)
  const b = new Date(next.start_time)
  const overnight = a.getDate() !== b.getDate() || a.getMonth() !== b.getMonth() ||
    a.getFullYear() !== b.getFullYear()
  return overnight ? PB_NIGHT_PAUSE_MS : PB_PORT_PAUSE_MS
}

async function openPlayback (fromMs, toMs) {
  showView('playback')
  pbTeardown()
  const trips = allTrips
    .filter((tr) => tr.stop_time != null && tr.start_time >= fromMs && tr.start_time <= toMs)
    .sort((a, b) => a.start_time - b.start_time)
  $('#pb-title').textContent = `${fmtDate(fromMs)} – ${fmtDate(toMs)}`
  $('#pb-status').textContent = ''
  if (!trips.length || typeof L === 'undefined') {
    pbResetControls()
    $('#pb-map').hidden = true
    $('#pb-status').textContent = trips.length ? t('playbackNoMap') : t('playbackEmpty')
    return
  }

  const host = $('#pb-map')
  host.hidden = false
  // zoomSnap 0 allows fractional zoom, which the per-frame easing needs.
  const map = L.map(host, { zoomControl: true, zoomSnap: 0 })
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map)
  L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenSeaMap'
  }).addTo(map)
  map.setView([trips[0].start_lat || 0, trips[0].start_lon || 0], 12)

  pb = {
    map,
    trips,
    from: fromMs,
    to: toMs,
    // Every trip's track, fetched lazily and kept so a replay costs no requests.
    tracks: new Map(),
    index: -1,
    points: [],
    i: 0,
    clock: 0,
    // Ground distance covered so far across the whole selected range: a log for
    // the passage, not per leg, so it keeps climbing from one trip to the next.
    meters: 0,
    speed: 1,
    // Current and wanted zoom, eased together each frame. Leaflet is created
    // with zoomSnap 0 so these can be fractional and the change reads as a
    // continuous glide rather than a step between whole zoom levels.
    zoom: 0,
    zoomTarget: 0,
    playing: true,
    // Playback milliseconds still to rest in port, or 0 when under way. Counted
    // down rather than held as a deadline, so pausing during a port stop resumes
    // it where it was instead of finding it already expired.
    pauseLeft: 0,
    last: 0,
    raf: 0,
    done: false,
    boat: null,
    // Total sailing time in range, for the progress bar; port pauses are short
    // enough not to be worth modelling in it.
    totalMs: trips.reduce((s, tr) => s + (tr.stop_time - tr.start_time), 0),
    playedMs: 0
  }
  const run = pb
  $('#pb-toggle').hidden = false
  pbRenderSpeeds()
  pbRenderToggle()
  await pbStartTrip(0)
  // Back-then-play again while the first track was in flight would otherwise
  // start a second loop on the newer run's state.
  if (pb === run) {
    pbLoop()
  }
}

// Fetch a trip's track, from the cache when we already have it. Returns [] for a
// trip with no logged position, which playback skips.
async function pbTrack (trip) {
  if (pb.tracks.has(trip.id)) {
    return pb.tracks.get(trip.id)
  }
  let points
  try {
    points = (await getJSON(`${READ}/trips/${trip.id}/track`)).points || []
  } catch (e) {
    // Don't cache a failure: InfluxDB may just have been briefly unreachable,
    // and a replay should try the trip again rather than skip it for good.
    return []
  }
  if (pb) {
    pb.tracks.set(trip.id, points)
  }
  return points
}

// Move to trip n, skipping any without a track. Fits the map to the whole trip
// so a long passage zooms out and a harbour shuffle stays close in, then holds
// that zoom while the boat is followed.
async function pbStartTrip (n) {
  const at = pb
  $('#pb-status').textContent = t('loadingTrack')
  for (let k = n; k < at.trips.length; k++) {
    const points = await pbTrack(at.trips[k])
    // Playback was torn down (or restarted) while the track was in flight.
    if (pb !== at) {
      return false
    }
    if (points.length < 2) {
      // A trip with no logged track is skipped, so its time must leave the
      // progress bar's denominator too or the bar can never reach the end.
      at.totalMs -= at.trips[k].stop_time - at.trips[k].start_time
      continue
    }
    at.index = k
    at.points = points
    at.i = 0
    at.clock = points[0].t
    at.pauseLeft = 0
    // Start a fresh trail run, so the new trip's first step doesn't extend the
    // previous trip's last polyline straight across the harbour.
    at.seg = null
    // Colour the trail against this trip's own speed range, as the detail map's
    // heat-line does, so a slow day still shows its fast stretches.
    const sogs = points.map((p) => p.sog).filter((s) => s != null)
    at.lo = sogs.length ? Math.min(...sogs) : 0
    at.hi = sogs.length ? Math.max(...sogs) : 0
    $('#pb-status').textContent = ''
    // Aim at the zoom that would frame the whole leg, capped so a hop across a
    // harbour doesn't dive to street level. The frame loop eases towards it, so
    // a long passage opens out and the next short leg draws back in gradually
    // instead of the view jumping between legs.
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon]))
    at.zoomTarget = Math.min(15, at.map.getBoundsZoom(bounds, false, L.point(50, 50)))
    // Nothing to ease from on the first leg: start there.
    if (!at.zoom) {
      at.zoom = at.zoomTarget
      at.map.setView([points[0].lat, points[0].lon], at.zoom, { animate: false })
    }
    pbEnsureBoat(points[0])
    // Warm the next trip's track while this one plays, so the pause in port
    // isn't spent waiting on InfluxDB.
    if (at.trips[k + 1]) {
      pbTrack(at.trips[k + 1])
    }
    return true
  }
  pbFinish()
  return false
}

function pbFinish () {
  if (!pb) {
    return
  }
  pb.done = true
  pb.playing = false
  if (pb.boat) {
    pb.boat.setOpacity(0.85)
  }
  $('#pb-status').textContent = pb.index < 0 ? t('playbackNoTrack') : t('playbackDone')
  // The progress bar measures trip durations but advances over track spans,
  // which start at the first logged fix — a trip whose logging began late would
  // otherwise leave the bar a hair short of the end. It is finished; say so.
  $('#pb-fill').style.width = pb.index < 0 ? '0%' : '100%'
  pbRenderToggle()
  // Pull back over the whole passage that was drawn, so the closing picture is
  // the story of the cruise rather than wherever the boat happened to stop. A
  // flight rather than a jump, to match the easing during playback.
  if (pb.drawn && pb.drawn.length) {
    pb.map.flyToBounds(L.latLngBounds(pb.drawn), { padding: [30, 30], duration: 1.6 })
  }
}

// The boat: a heading-rotated symbol with a floater pinned beside it carrying
// the live readout. The glyph rotates inside the icon so the floater stays
// upright and legible.
//
// The icon's markup is built once and afterwards only its text and transform are
// written. Rebuilding the divIcon each frame (setIcon) tears down and recreates
// the whole marker element sixty times a second, which both stutters visibly and
// pushes frame times past the delta clamp in pbFrame — playback then drags along
// slower than the speed control claims.
function pbEnsureBoat (p) {
  if (pb.boat) {
    return
  }
  const icon = L.divIcon({
    className: 'pb-boat-icon',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    html:
      '<div class="pb-boat">' +
      '<svg class="pb-glyph" viewBox="0 0 24 24" width="24" height="24">' +
      '<path d="M12 1 L19 22 L12 18 L5 22 Z" fill="currentColor" stroke="#fff" ' +
      'stroke-width="1.5" stroke-linejoin="round"/></svg>' +
      '<div class="pb-float">' +
      `<div class="pb-row pb-live"><span class="pb-k">STW</span><span class="pb-v pb-stw">–</span></div>` +
      `<div class="pb-row pb-live"><span class="pb-k">${escapeHtml(t('tripMeter'))}</span>` +
      '<span class="pb-v pb-trip">–</span></div>' +
      `<div class="pb-motor" hidden>${escapeHtml(t('motor'))}</div>` +
      '<div class="pb-port" hidden></div>' +
      '</div></div>'
  })
  pb.boat = L.marker([p.lat, p.lon], {
    icon, interactive: false, keyboard: false, zIndexOffset: 1000
  }).addTo(pb.map)
  const el = pb.boat.getElement()
  pb.el = {
    glyph: el.querySelector('.pb-glyph'),
    stw: el.querySelector('.pb-stw'),
    trip: el.querySelector('.pb-trip'),
    motor: el.querySelector('.pb-motor'),
    port: el.querySelector('.pb-port'),
    live: [...el.querySelectorAll('.pb-live')]
  }
}

// In port the readout gives way to the place name; under way it shows speed, the
// running distance for the whole selection, and an engine badge when the motor
// was on. Values are only written when they change, so a frame that moves the
// boat a few metres doesn't touch the DOM at all.
function pbSetBoat (latlng, bearing, p, portLabel) {
  pb.boat.setLatLng(latlng)
  const e = pb.el
  const deg = Math.round(bearing)
  if (deg !== pb.lastDeg) {
    e.glyph.style.transform = `rotate(${deg}deg)`
    pb.lastDeg = deg
  }
  const inPort = portLabel != null
  if (inPort !== pb.lastInPort) {
    e.live.forEach((r) => { r.hidden = inPort })
    e.port.hidden = !inPort
    pb.lastInPort = inPort
    if (!inPort) {
      pb.lastStw = pb.lastTrip = pb.lastMotor = null
    }
  }
  if (inPort) {
    if (portLabel !== pb.lastPort) {
      e.port.textContent = portLabel
      pb.lastPort = portLabel
    }
    e.motor.hidden = true
    return
  }
  const stw = p && p.stw != null ? `${n(toKnots(p.stw), 1)} kn` : '–'
  if (stw !== pb.lastStw) {
    e.stw.textContent = stw
    pb.lastStw = stw
  }
  const trip = `${n(pb.meters / 1852, 1)} NM`
  if (trip !== pb.lastTrip) {
    e.trip.textContent = trip
    pb.lastTrip = trip
  }
  const motor = !!(p && p.motor)
  if (motor !== pb.lastMotor) {
    e.motor.hidden = !motor
    pb.lastMotor = motor
  }
}

// One animation step. The virtual clock advances by real elapsed time scaled by
// the compression factor, so the speed control and a slow device both stay
// honest; every track step the clock passes is drawn as a trail segment and
// added to the trip meter.
function pbFrame (now) {
  if (!pb) {
    return
  }
  // Paused or finished: let the loop die rather than spin doing nothing. It is
  // started again by pbLoop when the user resumes or replays.
  if (!pb.playing) {
    pb.raf = 0
    return
  }
  // Clamped so a backgrounded tab (no frames, then one huge delta) resumes where
  // it left off instead of jumping a leg ahead.
  const dt = Math.min(250, now - pb.last)
  pb.last = now
  // Resting in port between two trips.
  if (pb.pauseLeft > 0) {
    pb.pauseLeft -= dt
    if (pb.pauseLeft <= 0) {
      pb.pauseLeft = 0
      pbStartTrip(pb.index + 1)
    }
    pb.raf = requestAnimationFrame(pbFrame)
    return
  }

  const points = pb.points
  if (points.length < 2) {
    pb.raf = requestAnimationFrame(pbFrame)
    return
  }
  // Virtual milliseconds per real millisecond.
  const scale = (3600000 / (PB_SEC_PER_HOUR * 1000)) * pb.speed
  pb.clock += dt * scale
  pb.playedMs += dt * scale

  while (pb.i < points.length - 1 && points[pb.i + 1].t <= pb.clock) {
    pbDrawStep(points[pb.i], points[pb.i + 1])
    pb.i++
  }

  const a = points[pb.i]
  const b = points[Math.min(pb.i + 1, points.length - 1)]
  const span = b.t - a.t
  const f = span > 0 ? Math.max(0, Math.min(1, (pb.clock - a.t) / span)) : 0
  const lat = a.lat + (b.lat - a.lat) * f
  const lon = a.lon + (b.lon - a.lon) * f
  pbSetBoat([lat, lon], pbBearing(a, b), f < 0.5 ? a : b)
  // Follow the boat every frame rather than panning in jumps: a continuous
  // setView reads as the chart sliding under a fixed boat. The zoom eases
  // towards the leg's target on an exponential curve, framed in elapsed time so
  // it glides at the same rate whatever the frame rate.
  pb.zoom += (pb.zoomTarget - pb.zoom) * (1 - Math.exp(-dt / 600))
  pb.map.setView([lat, lon], pb.zoom, { animate: false })
  pbRenderClock(a.t + (b.t - a.t) * f)

  // Trip over: rest in port, then pick up the next one.
  if (pb.i >= points.length - 1 && pb.clock >= points[points.length - 1].t) {
    const trip = pb.trips[pb.index]
    const next = pb.trips[pb.index + 1]
    const label = placeOf(trip, 'stop') || null
    const pause = pbPauseAfter(trip, next)
    if (!next) {
      pbFinish()
      pb.raf = requestAnimationFrame(pbFrame)
      return
    }
    pbSetBoat([lat, lon], 0, null,
      `${label ? label + ' · ' : ''}${pause >= PB_NIGHT_PAUSE_MS ? t('overnight') : t('inPort')}`)
    pb.pauseLeft = pause / pb.speed
    // Idle the frame loop until the next trip's points are in: without this the
    // finished trip's tail would replay and schedule a second pause.
    pb.points = []
  }
  pb.raf = requestAnimationFrame(pbFrame)
}

// Speed is quantised into a few bands so consecutive steps at a similar speed
// extend one polyline instead of each adding their own. A trip is ~600 steps and
// a fortnight's cruise a dozen trips; one SVG path per step would be tens of
// thousands of elements and the map would crawl. At this many bands the
// heat-line still reads as continuous.
const PB_SPEED_BANDS = 8

// Band -1 is "speed unknown", kept apart from the slowest band so a dropout is
// drawn grey rather than passed off as a crawl.
function pbBand (s) {
  if (s == null) {
    return -1
  }
  if (pb.hi <= pb.lo) {
    return 0
  }
  const f = (s - pb.lo) / (pb.hi - pb.lo)
  return Math.max(0, Math.min(PB_SPEED_BANDS - 1, Math.floor(f * PB_SPEED_BANDS)))
}

// Lay down the trail behind the boat and add the step's ground distance to the
// trip meter. Colour is scaled to the current trip's own speed range, the same
// way the detail map's heat-line is.
function pbDrawStep (a, b) {
  const s = a.sog != null && b.sog != null ? (a.sog + b.sog) / 2 : (a.sog != null ? a.sog : b.sog)
  const band = pbBand(s)
  if (pb.seg && pb.seg.band === band) {
    pb.seg.line.addLatLng([b.lat, b.lon])
  } else {
    const mid = band < 0 ? null : pb.lo + ((pb.hi - pb.lo) * (band + 0.5)) / PB_SPEED_BANDS
    const line = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
      color: sogColor(mid, pb.lo, pb.hi), weight: 3, opacity: 0.9
    }).addTo(pb.map)
    pb.seg = { band, line }
  }
  pb.meters += pbLegMeters(pb.map, a, b)
  pb.drawn = pb.drawn || []
  pb.drawn.push([a.lat, a.lon], [b.lat, b.lon])
}

function pbRenderClock (tMs) {
  // Only to the minute, so this is a DOM write once a minute of ship's time
  // rather than on every frame.
  const label = `${fmtDate(tMs)} ${fmtTime(tMs)}`
  if (label !== pb.lastClock) {
    $('#pb-clock').textContent = label
    pb.lastClock = label
  }
  const done = Math.max(0, Math.min(1, pb.playedMs / (pb.totalMs || 1)))
  $('#pb-fill').style.width = `${(done * 100).toFixed(1)}%`
}

function pbRenderToggle () {
  const b = $('#pb-toggle')
  b.textContent = pb.done ? t('replay') : (pb.playing ? t('pause') : t('play'))
}

function pbRenderSpeeds () {
  const box = $('#pb-speeds')
  box.innerHTML = ''
  PB_SPEEDS.forEach((s) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'year-chip' + (s === pb.speed ? ' on' : '')
    b.textContent = `${n(s, s % 1 ? 1 : 0)}×`
    b.addEventListener('click', () => {
      if (!pb) {
        return
      }
      pb.speed = s
      pbRenderSpeeds()
    })
    box.appendChild(b)
  })
}

// ---- helpers -------------------------------------------------------------

function showView (which) {
  $('#list-view').hidden = which !== 'list'
  $('#detail-view').hidden = which !== 'detail'
  $('#playback-view').hidden = which !== 'playback'
  // Tear the maps down when leaving their view, so tile layers and timers don't
  // linger hidden.
  if (which !== 'detail') {
    teardownTrack()
  }
  if (which !== 'playback') {
    pbTeardown()
  }
}

// Tear the map (and everything hung off it) down so its tile layers and timers
// don't linger.
function teardownTrack () {
  if (trackMap) {
    trackMap.remove()
  }
  trackMap = null
  trackPoints = []
  scrubDot = null
  scrubEvents = null
  scrubFields = []
  scrubHasMotor = false
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
$('#pb-back').addEventListener('click', loadList)
$('#scan-btn').addEventListener('click', runScan)
$('#pb-open').addEventListener('click', () => {
  const from = $('#pb-from').value
  const to = $('#pb-to').value
  if (!from || !to) {
    setStatus(t('pickDates'), true)
    return
  }
  openPlayback(new Date(from + 'T00:00:00').getTime(), new Date(to + 'T23:59:59').getTime())
})
$('#pb-toggle').addEventListener('click', () => {
  if (!pb) {
    return
  }
  if (pb.done) {
    openPlayback(pb.from, pb.to)
    return
  }
  pb.playing = !pb.playing
  pbRenderToggle()
  // The loop stops itself when paused, so resuming has to start it again.
  if (pb.playing) {
    pbLoop()
  }
})
applyStatic()
loadList()
