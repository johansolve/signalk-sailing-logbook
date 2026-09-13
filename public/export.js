'use strict'

// Video export for the playback.
//
// This does not record the live map. It re-renders the passage frame by frame
// onto a canvas at a fixed frame rate, waiting for every tile to arrive before
// each frame is captured, and encodes the result with WebCodecs. So the output
// is identical whether it was made on fibre or on the boat's 4G — the two things
// that ruin a screen recording of the playback, uneven frame timing and tiles
// that hadn't loaded yet, cannot occur here.
//
// Nothing is shared with the live map beyond the trip data: the drawing is plain
// canvas and the projection is the standard slippy-map one, which is a couple of
// dozen lines and avoids bending Leaflet into something it isn't.

const EX_FPS = 30
const EX_TILE = 256
// Seconds of video the opening title occupies.
const EX_TITLE_S = 2.5
// Seconds the film holds on the destination once the boat has arrived.
const EX_ARRIVAL_S = 2
// Fade of the title, in seconds.
const EX_FADE_S = 0.5
// The squarer shapes lead on purpose: a chart is two-dimensional and a 16:9
// letterbox throws away most of the sea a passage runs through. The 16:9 pair is
// offered anyway for where a clip has to fit a widescreen or a phone-story frame.
// Listed tallest to widest.
const EX_SIZES = {
  mobile: { w: 1080, h: 1920, label: '9:16' },
  portrait: { w: 1080, h: 1440, label: '3:4' },
  square: { w: 1080, h: 1080, label: '1:1' },
  landscape: { w: 1440, h: 1080, label: '4:3' },
  wide: { w: 1920, h: 1080, label: '16:9' }
}
// Target bits per pixel per frame. Chosen so a 1080×1440 clip lands near
// 2.5 Mbit/s — proven indistinguishable from the old 8 Mbit/s at a full crop.
const EX_BITS_PER_PIXEL = 0.055
// Tiles are fetched with a small pool: politeness to the tile servers, and a
// stampede of a hundred parallel requests is slower than a steady few anyway.
const EX_TILE_CONCURRENCY = 6
const EX_TILE_RETRIES = 2
// A tile that neither loads nor errors — a stalled connection the browser never
// resets — would otherwise hold its slot in the pool for ever, and since the
// render only checks for cancellation between frames, the whole export would
// wedge inside a frame with no way out. A timeout turns that into an ordinary
// retry, then a hole in the chart drawn as water.
const EX_TILE_TIMEOUT_MS = 12000

let exBusy = false

// ---- projection ----------------------------------------------------------

function exLonX (lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z)
}
function exLatY (lat, z) {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z)
}

// Everything needed to place both tiles and track points for one frame's view.
// Tiles are drawn from the next zoom level up and scaled down rather than up:
// downscaling stays sharp, upscaling goes soft.
function exView (center, zoom, w, h, maxZoom) {
  const tileZoom = Math.max(0, Math.min(maxZoom, Math.ceil(zoom)))
  const scale = Math.pow(2, zoom - tileZoom)
  const originX = exLonX(center.lon, tileZoom) * EX_TILE - w / 2 / scale
  const originY = exLatY(center.lat, tileZoom) * EX_TILE - h / 2 / scale
  return {
    tileZoom,
    scale,
    originX,
    originY,
    w,
    h,
    x: (lon) => (exLonX(lon, tileZoom) * EX_TILE - originX) * scale,
    y: (lat) => (exLatY(lat, tileZoom) * EX_TILE - originY) * scale
  }
}

// ---- tiles ---------------------------------------------------------------

const exTileCache = new Map()
let exInFlight = 0

function exLoadTile (url) {
  if (exTileCache.has(url)) {
    return exTileCache.get(url)
  }
  const p = (async () => {
    for (let attempt = 0; ; attempt++) {
      while (exInFlight >= EX_TILE_CONCURRENCY) {
        await new Promise((r) => setTimeout(r, 15))
      }
      exInFlight++
      try {
        return await new Promise((resolve, reject) => {
          const img = new Image()
          // The tile servers send Access-Control-Allow-Origin: *, so the canvas
          // stays untainted and can be read back by the encoder.
          img.crossOrigin = 'anonymous'
          // Without this the image inherits the page's `no-referrer` and OSM
          // hands back its "blocked" tile — with a 200, so the frame renders and
          // the whole film comes out papered with it. Same policy the map uses.
          img.referrerPolicy = 'strict-origin-when-cross-origin'
          const timer = setTimeout(() => {
            img.src = ''
            reject(new Error('tile timeout'))
          }, EX_TILE_TIMEOUT_MS)
          img.onload = () => {
            clearTimeout(timer)
            resolve(img)
          }
          img.onerror = () => {
            clearTimeout(timer)
            reject(new Error('tile'))
          }
          img.src = url
        })
      } catch (e) {
        // A missing tile is a hole in the sea chart, not a reason to abandon the
        // export; give up on it after a couple of tries and draw water instead.
        if (attempt >= EX_TILE_RETRIES) {
          return null
        }
      } finally {
        exInFlight--
      }
    }
  })()
  exTileCache.set(url, p)
  return p
}

function exTileUrls (view) {
  const urls = []
  const x0 = Math.floor(view.originX / EX_TILE)
  const y0 = Math.floor(view.originY / EX_TILE)
  const x1 = Math.floor((view.originX + view.w / view.scale) / EX_TILE)
  const y1 = Math.floor((view.originY + view.h / view.scale) / EX_TILE)
  const span = Math.pow(2, view.tileZoom)
  for (let ty = y0; ty <= y1; ty++) {
    if (ty < 0 || ty >= span) {
      continue
    }
    for (let tx = x0; tx <= x1; tx++) {
      urls.push({ tx, ty, wrapped: ((tx % span) + span) % span })
    }
  }
  return urls
}

// Draw one tile layer, awaiting every tile in view first so a frame is never
// captured half-drawn.
async function exDrawTiles (ctx, view, template, layerMaxZoom) {
  if (view.tileZoom > layerMaxZoom) {
    return
  }
  const tiles = exTileUrls(view)
  const loaded = await Promise.all(tiles.map((tile) =>
    exLoadTile(template
      .replace('{z}', view.tileZoom)
      .replace('{x}', tile.wrapped)
      .replace('{y}', tile.ty))))
  const size = EX_TILE * view.scale
  tiles.forEach((tile, i) => {
    const img = loaded[i]
    if (!img) {
      return
    }
    const px = (tile.tx * EX_TILE - view.originX) * view.scale
    const py = (tile.ty * EX_TILE - view.originY) * view.scale
    // Half a pixel of overlap, so seams don't show as hairlines after scaling.
    ctx.drawImage(img, px, py, size + 0.5, size + 0.5)
  })
}

// ---- timeline ------------------------------------------------------------

// The passage as a list of timed segments. Same compression as the live playback
// — an hour under way is PB_SEC_PER_HOUR seconds — divided by the speed chosen
// on the controls, and the same rests in port, so the film is the playback you
// just watched rather than a different edit of it.
function exTimeline (legs, speed) {
  const segs = [{ type: 'title', dur: EX_TITLE_S }]
  legs.forEach((leg, i) => {
    const span = leg.points[leg.points.length - 1].t - leg.points[0].t
    segs.push({ type: 'leg', leg, dur: (span / 3600000) * PB_SEC_PER_HOUR / speed })
    const next = legs[i + 1]
    if (next) {
      const pause = pbPauseAfter(leg.trip, next.trip)
      segs.push({
        type: 'port',
        leg,
        next,
        dur: pause / 1000 / speed,
        overnight: pause >= PB_NIGHT_PAUSE_MS,
        label: placeOf(leg.trip, 'stop') || ''
      })
    }
  })
  // A short hold on the destination at the end, the boat resting on its marker
  // with the readout put away — the same arrival the live playback shows, and a
  // moment for the finished route to be read before the film loops or stops.
  segs.push({ type: 'arrival', leg: legs[legs.length - 1], dur: EX_ARRIVAL_S })
  let at = 0
  segs.forEach((s) => {
    s.start = at
    at += s.dur
  })
  return { segs, total: at }
}

function exSegAt (timeline, tSec) {
  for (const s of timeline.segs) {
    if (tSec < s.start + s.dur) {
      return s
    }
  }
  return timeline.segs[timeline.segs.length - 1]
}

// Position, heading and readings at a moment inside a leg.
function exSample (leg, frac) {
  const pts = leg.points
  const target = pts[0].t + (pts[pts.length - 1].t - pts[0].t) * frac
  let i = leg.cursor || 0
  while (i < pts.length - 2 && pts[i + 1].t <= target) {
    i++
  }
  leg.cursor = i
  const a = pts[i]
  const b = pts[Math.min(i + 1, pts.length - 1)]
  const span = b.t - a.t
  const f = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 0
  return {
    index: i,
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    bearing: pbBearing(a, b),
    point: f < 0.5 ? a : b,
    t: target
  }
}

// The cap is anchored to a fixed square patch of sea, ~0.14° on a side, projected
// as a pixel-square (its east-west span widened by 1 / cos lat) so the fit depends
// only on the shorter canvas dimension, not on the aspect ratio, then re-fitted
// around each leg's own centre. Mirrors the live view.
const EX_MAX_FRAME_SPAN = 0.143

// The largest zoom at which the box still fits the w×h canvas with its margin.
function exFitZoom (box, w, h) {
  const pad = 0.82
  for (let z = 19; z >= 3; z -= 0.25) {
    const dx = Math.abs(exLonX(box.maxLon, z) - exLonX(box.minLon, z)) * EX_TILE
    const dy = Math.abs(exLatY(box.minLat, z) - exLatY(box.maxLat, z)) * EX_TILE
    if (dx <= w * pad && dy <= h * pad) {
      return z
    }
  }
  return 3
}

// The zoom that frames a whole leg in this canvas, capped like the live view so
// a hop across a harbour doesn't dive to street level.
function exZoomFor (points, w, h) {
  let minLat = 90
  let maxLat = -90
  let minLon = 180
  let maxLon = -180
  points.forEach((p) => {
    minLat = Math.min(minLat, p.lat)
    maxLat = Math.max(maxLat, p.lat)
    minLon = Math.min(minLon, p.lon)
    maxLon = Math.max(maxLon, p.lon)
  })
  const cLat = (minLat + maxLat) / 2
  const cLon = (minLon + maxLon) / 2
  const half = EX_MAX_FRAME_SPAN / 2
  const halfLon = half / Math.cos(cLat * Math.PI / 180)
  const refBox = {
    minLat: cLat - half,
    maxLat: cLat + half,
    minLon: cLon - halfLon,
    maxLon: cLon + halfLon
  }
  const legZoom = exFitZoom({ minLat, minLon, maxLat, maxLon }, w, h)
  return {
    zoom: Math.min(exFitZoom(refBox, w, h), legZoom),
    center: { lat: cLat, lon: cLon }
  }
}

// ---- drawing -------------------------------------------------------------

const EX_INK = '#12212e'
const EX_PANEL = 'rgba(255,255,255,0.93)'
const EX_MUTED = '#5a6b7d'

function exRoundRect (ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// The trail so far: every leg already sailed in full, plus the current leg up to
// the boat. Grouped by speed band so a long passage is a handful of strokes
// rather than one per sample.
function exDrawTrail (ctx, view, legs, upto, uptoIndex, s) {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (let li = 0; li <= upto && li < legs.length; li++) {
    const leg = legs[li]
    const last = li === upto ? uptoIndex : leg.points.length - 1
    if (last < 1) {
      continue
    }
    let band = null
    ctx.lineWidth = 5
    for (let i = 1; i <= last; i++) {
      const a = leg.points[i - 1]
      const b = leg.points[i]
      const bandNow = leg.bands[i]
      if (bandNow !== band) {
        if (band !== null) {
          ctx.stroke()
        }
        band = bandNow
        ctx.strokeStyle = leg.colors[bandNow]
        ctx.beginPath()
        ctx.moveTo(view.x(a.lon), view.y(a.lat))
      }
      ctx.lineTo(view.x(b.lon), view.y(b.lat))
    }
    // On the current leg, run the last stroke right up to the interpolated
    // position so the trail meets the boat instead of stopping a sample short.
    if (li === upto && s) {
      ctx.lineTo(view.x(s.lon), view.y(s.lat))
    }
    if (band !== null) {
      ctx.stroke()
    }
  }
}

function exDrawBoat (ctx, x, y, bearing) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate((bearing * Math.PI) / 180)
  ctx.beginPath()
  ctx.moveTo(0, -19)
  ctx.lineTo(13, 20)
  ctx.lineTo(0, 13)
  ctx.lineTo(-13, 20)
  ctx.closePath()
  ctx.fillStyle = '#1f6f8b'
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = '#fff'
  ctx.stroke()
  ctx.restore()
}

// A persistent port marker: a dot at the harbour with its name beside it, the
// same green/red/accent coding as the live playback. The label flips to the left
// when the dot is near the right edge so it never runs off the frame.
function exDrawPortTag (ctx, view, tag) {
  const x = view.x(tag.lon)
  const y = view.y(tag.lat)
  ctx.beginPath()
  ctx.arc(x, y, 8, 0, Math.PI * 2)
  ctx.fillStyle = tag.kind === 'start' ? '#2a7d4f' : (tag.kind === 'end' ? '#b23b3b' : '#1f6f8b')
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = '#fff'
  ctx.stroke()
  if (!tag.label) {
    return
  }
  const sub = tag.overnight ? t('overnight') : ''
  ctx.font = '600 24px system-ui, -apple-system, sans-serif'
  let tw = ctx.measureText(tag.label).width
  if (sub) {
    ctx.font = '500 18px system-ui, -apple-system, sans-serif'
    tw = Math.max(tw, ctx.measureText(sub).width)
  }
  const padX = 12
  const bh = sub ? 56 : 38
  const bw = tw + padX * 2
  let bx = x + 16
  if (bx + bw > ctx.canvas.width - 12) {
    bx = x - 16 - bw
  }
  const by = Math.max(6, Math.min(ctx.canvas.height - bh - 6, y - bh / 2))
  ctx.fillStyle = EX_PANEL
  ctx.strokeStyle = 'rgba(20,40,60,0.18)'
  ctx.lineWidth = 2
  exRoundRect(ctx, bx, by, bw, bh, 9)
  ctx.fill()
  ctx.stroke()
  ctx.textAlign = 'left'
  ctx.fillStyle = EX_INK
  ctx.font = '600 24px system-ui, -apple-system, sans-serif'
  ctx.fillText(tag.label, bx + padX, by + (sub ? 24 : bh / 2 + 8))
  if (sub) {
    ctx.fillStyle = EX_MUTED
    ctx.font = '500 18px system-ui, -apple-system, sans-serif'
    ctx.fillText(sub, bx + padX, by + 46)
  }
}

// The readout that rides beside the boat. Flips to the other side when the boat
// is near the right edge, so it never runs off the frame.
function exDrawFloat (ctx, x, y, rows, motor) {
  const padX = 18
  const padY = 14
  const lineH = 34
  ctx.font = '600 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  let wide = 0
  rows.forEach((r) => {
    ctx.font = '500 22px system-ui, sans-serif'
    const kw = ctx.measureText(r[0]).width
    ctx.font = '700 26px system-ui, sans-serif'
    wide = Math.max(wide, kw + 24 + ctx.measureText(r[1]).width)
  })
  const bw = wide + padX * 2
  const bh = rows.length * lineH + padY * 2 + (motor ? 26 : 0)
  let bx = x + 30
  if (bx + bw > ctx.canvas.width - 20) {
    bx = x - 30 - bw
  }
  const by = Math.max(20, Math.min(ctx.canvas.height - bh - 20, y - bh / 2))
  ctx.fillStyle = EX_PANEL
  ctx.strokeStyle = 'rgba(20,40,60,0.18)'
  ctx.lineWidth = 2
  exRoundRect(ctx, bx, by, bw, bh, 14)
  ctx.fill()
  ctx.stroke()
  rows.forEach((r, i) => {
    const ty = by + padY + lineH * i + 25
    ctx.textAlign = 'left'
    ctx.fillStyle = EX_MUTED
    ctx.font = '500 22px system-ui, sans-serif'
    ctx.fillText(r[0], bx + padX, ty)
    ctx.textAlign = 'right'
    ctx.fillStyle = EX_INK
    ctx.font = '700 26px system-ui, sans-serif'
    ctx.fillText(r[1], bx + bw - padX, ty)
  })
  if (motor) {
    ctx.textAlign = 'left'
    ctx.fillStyle = '#b4682a'
    ctx.font = '600 21px system-ui, sans-serif'
    ctx.fillText(t('motor').toUpperCase(), bx + padX, by + bh - padY - 2)
  }
  ctx.textAlign = 'left'
}

// A pill in the top corner carrying the moment in the passage.
function exDrawClock (ctx, label) {
  ctx.font = '600 27px system-ui, sans-serif'
  const w = ctx.measureText(label).width + 40
  ctx.fillStyle = EX_PANEL
  exRoundRect(ctx, 28, 28, w, 54, 27)
  ctx.fill()
  ctx.fillStyle = EX_INK
  ctx.textAlign = 'left'
  ctx.fillText(label, 48, 63)
}

// The opening and closing titles sit in a band along the bottom rather than
// covering the frame: the chart is the subject, and dimming all of it to read two
// lines of text hides the very thing the film is about.
function exDrawCard (ctx, w, h, lines, alpha) {
  const gap = 16
  const textH = lines.reduce((s, l) => s + l.size + gap, 0) - gap
  const padBottom = Math.round(h * 0.07)
  const band = textH + padBottom + Math.round(h * 0.14)
  ctx.save()
  ctx.globalAlpha = alpha
  const grad = ctx.createLinearGradient(0, h - band, 0, h)
  grad.addColorStop(0, 'rgba(8,22,32,0)')
  grad.addColorStop(0.45, 'rgba(8,22,32,0.66)')
  grad.addColorStop(1, 'rgba(8,22,32,0.9)')
  ctx.fillStyle = grad
  ctx.fillRect(0, h - band, w, band)
  ctx.textAlign = 'center'
  let y = h - padBottom - textH
  lines.forEach((l) => {
    y += l.size
    ctx.fillStyle = l.muted ? 'rgba(255,255,255,0.78)' : '#fff'
    ctx.font = `${l.weight || 700} ${l.size}px system-ui, -apple-system, sans-serif`
    ctx.fillText(l.text, w / 2, y)
    y += gap
  })
  ctx.textAlign = 'left'
  ctx.restore()
}

// ---- assembling the passage ----------------------------------------------

function exMeters (a, b) {
  const R = 6371000
  const φ1 = (a.lat * Math.PI) / 180
  const φ2 = (b.lat * Math.PI) / 180
  const dφ = φ2 - φ1
  const dλ = ((b.lon - a.lon) * Math.PI) / 180
  const x = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

// Fetch every leg's track and precompute what the frame loop would otherwise
// redo 900 times: the speed band of each step, its colour, and the running
// distance so the trip meter is a lookup.
async function exBuildLegs (trips, onProgress) {
  const legs = []
  let meters = 0
  for (let i = 0; i < trips.length; i++) {
    onProgress(i / trips.length)
    let points = []
    try {
      points = (await getJSON(`${READ}/trips/${trips[i].id}/track`)).points || []
    } catch (e) {
      points = []
    }
    if (points.length < 2) {
      continue
    }
    const sogs = points.map((p) => p.sog).filter((s) => s != null)
    const lo = sogs.length ? Math.min(...sogs) : 0
    const hi = sogs.length ? Math.max(...sogs) : 0
    const bands = [0]
    const dist = [meters]
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1]
      const b = points[k]
      const s = a.sog != null && b.sog != null ? (a.sog + b.sog) / 2 : (a.sog != null ? a.sog : b.sog)
      bands.push(s == null ? -1 : Math.max(0, Math.min(7, Math.floor(hi > lo ? ((s - lo) / (hi - lo)) * 8 : 0))))
      meters += exMeters(a, b)
      dist.push(meters)
    }
    const colors = {}
    for (let b = -1; b < 8; b++) {
      colors[b] = b < 0 ? '#888' : sogColor(lo + ((hi - lo) * (b + 0.5)) / 8, lo, hi)
    }
    legs.push({ trip: trips[i], points, bands, colors, dist })
  }
  return legs
}

// ---- the frame ------------------------------------------------------------

// Where the camera is and what the readout says, for a moment in the video.
function exStateAt (film, tSec) {
  const seg = exSegAt(film.timeline, tSec)
  const into = tSec - seg.start
  const frac = seg.dur > 0 ? Math.max(0, Math.min(1, into / seg.dur)) : 1
  if (seg.type === 'title') {
    return { seg, card: 'title', view: film.firstFrame, alpha: 1 - Math.max(0, (into - (seg.dur - EX_FADE_S)) / EX_FADE_S) }
  }
  if (seg.type === 'leg') {
    const li = film.legs.indexOf(seg.leg)
    const s = exSample(seg.leg, frac)
    return { seg, legIndex: li, sample: s, zoom: seg.leg.frame.zoom, center: { lat: s.lat, lon: s.lon } }
  }
  if (seg.type === 'arrival') {
    // The destination hold: the boat rests on its marker at the leg's own zoom,
    // port so the readout is dropped. No reframing — there is no next leg.
    const last = seg.leg.points[seg.leg.points.length - 1]
    return {
      seg,
      legIndex: film.legs.indexOf(seg.leg),
      port: true,
      sample: { lat: last.lat, lon: last.lon, bearing: 0, point: last, index: seg.leg.points.length - 1 },
      zoom: seg.leg.frame.zoom,
      center: { lat: last.lat, lon: last.lon }
    }
  }
  // In port: the boat lies still while the camera reframes for the next leg,
  // exactly as the live playback does, so the zoom change never happens under
  // way where it would fight the follow.
  const li = film.legs.indexOf(seg.leg)
  const last = seg.leg.points[seg.leg.points.length - 1]
  const ease = frac < 0.5 ? 2 * frac * frac : 1 - Math.pow(-2 * frac + 2, 2) / 2
  return {
    seg,
    legIndex: li,
    port: true,
    sample: { lat: last.lat, lon: last.lon, bearing: 0, point: last, index: seg.leg.points.length - 1 },
    zoom: seg.leg.frame.zoom + (seg.next.frame.zoom - seg.leg.frame.zoom) * ease,
    center: { lat: last.lat, lon: last.lon }
  }
}

async function exRenderFrame (ctx, film, tSec) {
  const w = film.w
  const h = film.h
  const st = exStateAt(film, tSec)
  const view = st.view
    ? exView(st.view.center, st.view.zoom, w, h, 19)
    : exView(st.center, st.zoom, w, h, 19)

  ctx.fillStyle = '#aad3df'
  ctx.fillRect(0, 0, w, h)
  await exDrawTiles(ctx, view, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', 19)
  await exDrawTiles(ctx, view, 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', 18)

  const legIndex = st.legIndex == null ? -1 : st.legIndex
  if (legIndex >= 0) {
    exDrawTrail(ctx, view, film.legs, legIndex, st.sample ? st.sample.index : 0, st.sample)
  }

  // Port markers reached so far, drawn under the boat.
  film.tags.forEach((tag) => {
    if (tSec >= tag.showFrom) {
      exDrawPortTag(ctx, view, tag)
    }
  })

  if (st.sample && !st.card) {
    const bx = view.x(st.sample.lon)
    const by = view.y(st.sample.lat)
    const leg = st.seg.leg
    const p = st.sample.point
    const nm = leg.dist[Math.min(st.sample.index, leg.dist.length - 1)] / 1852
    exDrawBoat(ctx, bx, by, st.sample.bearing)
    // In port the boat sits on its port marker, which names the harbour, so the
    // readout is dropped there rather than repeating it; under way it shows speed
    // and the running distance.
    if (!st.port) {
      exDrawFloat(ctx, bx, by, [
        [t('speed').toUpperCase(), p && p.stw != null ? `${n(toKnots(p.stw), 1)} kn` : '–'],
        [t('tripMeter').toUpperCase(), `${n(nm, 1)} NM`]
      ], p && p.motor)
    }
    exDrawClock(ctx, st.port
      ? fmtDate(st.sample.point.t)
      : `${fmtDate(st.sample.t)} ${fmtTime(st.sample.t)}`)
  }

  if (st.card === 'title') {
    exDrawCard(ctx, w, h, film.titleLines, st.alpha)
  }
}

// ---- encoding -------------------------------------------------------------

async function exEncode (film, onProgress, shouldStop) {
  const canvas = document.createElement('canvas')
  canvas.width = film.w
  canvas.height = film.h
  const ctx = canvas.getContext('2d', { alpha: false })

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: film.w, height: film.h },
    fastStart: 'in-memory'
  })
  let failure = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e }
  })
  // A modest variable bitrate, scaled to the frame. The obvious win looked like
  // constant-quality (quantizer) mode, but browsers that don't honour the
  // per-frame quantizer still report the config as supported and then fall back
  // to their own high default — which is where the stubborn 8 Mbit/s came from.
  // A plain bitrate is the one thing every encoder treats the same. Variable, so
  // the long flat stretches a chart is mostly made of cost well under the target
  // and the detail frames get the room; at this density the result is
  // indistinguishable from the old 8 Mbit/s output at a third of the size.
  encoder.configure({
    codec: 'avc1.4d0028',
    width: film.w,
    height: film.h,
    framerate: EX_FPS,
    bitrate: Math.round(film.w * film.h * EX_FPS * EX_BITS_PER_PIXEL),
    bitrateMode: 'variable',
    latencyMode: 'quality'
  })

  const frames = Math.max(1, Math.round(film.timeline.total * EX_FPS))
  const frameDur = Math.round(1e6 / EX_FPS)
  // finally releases the encoder on every exit — cancel, a hardware error thrown
  // mid-loop, or a rejecting flush — so the codec (and any queued VideoFrame)
  // isn't leaked. Frames are closed under their own finally for the same reason:
  // a throw from encode() must not strand the frame's buffer.
  try {
    for (let i = 0; i < frames; i++) {
      if (failure) {
        throw failure
      }
      if (shouldStop()) {
        return null
      }
      await exRenderFrame(ctx, film, i / EX_FPS)
      // Don't run further ahead than the encoder can swallow, or a long passage
      // builds a queue of uncompressed frames big enough to exhaust memory.
      while (encoder.encodeQueueSize > 8) {
        await new Promise((r) => setTimeout(r, 5))
      }
      const frame = new VideoFrame(canvas, { timestamp: i * frameDur, duration: frameDur })
      // Keyframes every four seconds: they are the expensive frames, and nothing
      // here needs to be seekable at finer grain than that.
      try {
        encoder.encode(frame, { keyFrame: i % (EX_FPS * 4) === 0 })
      } finally {
        frame.close()
      }
      onProgress(i / frames)
    }
    await encoder.flush()
    muxer.finalize()
    return new Blob([muxer.target.buffer], { type: 'video/mp4' })
  } finally {
    if (encoder.state !== 'closed') {
      encoder.close()
    }
  }
}

// ---- putting the film together -------------------------------------------

function exBuildFilm (legs, size, speed) {
  const { w, h } = size
  legs.forEach((leg) => {
    leg.cursor = 0
    leg.frame = exZoomFor(leg.points, w, h)
  })
  const first = legs[0].trip
  const last = legs[legs.length - 1].trip
  const from = placeOf(first, 'start') || t('unknown')
  const to = placeOf(last, 'stop') || t('unknown')
  const sameDay = fmtDate(first.start_time) === fmtDate(last.stop_time || last.start_time)
  const film = {
    w,
    h,
    legs,
    // The title holds on the same view the first leg opens on: centred on the
    // start position at the leg's zoom, not on the leg's midpoint. So when the
    // boat sets off the picture is already where the playback would put it, and
    // the title dissolves into motion rather than into a pan.
    firstFrame: { zoom: legs[0].frame.zoom, center: { lat: legs[0].points[0].lat, lon: legs[0].points[0].lon } },
    titleLines: [
      { text: `${from} → ${to}`, size: Math.round(w / 18) },
      {
        text: sameDay
          ? fmtDate(first.start_time)
          : `${fmtDate(first.start_time)} – ${fmtDate(last.stop_time || last.start_time)}`,
        size: Math.round(w / 30),
        weight: 500,
        muted: true
      }
    ],
  }
  film.timeline = exTimeline(legs, speed)
  // Port markers, matching the live playback: the departure harbour, then one at
  // each leg's arrival, the last being the destination. Each carries the time it
  // should first appear, so the film drops them as the boat reaches them rather
  // than showing the whole set from the outset.
  film.tags = [{
    lat: legs[0].points[0].lat,
    lon: legs[0].points[0].lon,
    label: placeOf(first, 'start') || '',
    kind: 'start',
    overnight: false,
    showFrom: 0
  }]
  film.timeline.segs.forEach((s) => {
    if (s.type === 'leg') {
      const pts = s.leg.points
      // The night is marked from the port segment that follows the leg; the last
      // leg has none (it ends in the arrival hold), so its marker never reads
      // night.
      const port = film.timeline.segs.find((o) => o.type === 'port' && o.leg === s.leg)
      film.tags.push({
        lat: pts[pts.length - 1].lat,
        lon: pts[pts.length - 1].lon,
        label: placeOf(s.leg.trip, 'stop') || '',
        kind: s.leg === legs[legs.length - 1] ? 'end' : 'port',
        overnight: port ? port.overnight : false,
        showFrom: s.start + s.dur
      })
    }
  })
  return film
}

// ---- UI -------------------------------------------------------------------

let exSize = 'portrait'
let exCancel = false
// A finished film held for the user to share on a fresh tap (see exShareResult).
let exResultFile = null

function exSupported () {
  return typeof window.VideoEncoder !== 'undefined' && typeof window.Mp4Muxer !== 'undefined'
}

// WebCodecs is a secure-context API, so over plain http on the boat's LAN the
// encoder simply isn't there. That is worth saying plainly — it looks identical
// to an unsupported browser otherwise, and the fix is just to use the https
// address rather than to go and find another browser.
function exUnsupportedReason () {
  return !window.isSecureContext ? t('exportInsecure') : t('exportUnsupported')
}

function exRenderSizes () {
  const box = document.querySelector('#ex-sizes')
  if (!box) {
    return
  }
  box.innerHTML = ''
  Object.keys(EX_SIZES).forEach((key) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'year-chip' + (key === exSize ? ' on' : '')
    b.textContent = `${t('size_' + key)} ${EX_SIZES[key].label}`
    b.addEventListener('click', () => {
      exSize = key
      exInvalidateResult()
      exRenderSizes()
    })
    box.appendChild(b)
  })
}

function exStatus (msg) {
  const el = document.querySelector('#ex-status')
  if (el) {
    el.textContent = msg || ''
  }
}

function exProgress (frac) {
  const el = document.querySelector('#ex-fill')
  if (el) {
    el.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`
  }
}

function exDownload (file) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

async function exRun () {
  if (exBusy) {
    exCancel = true
    return
  }
  if (!pb || !pb.trips || !pb.trips.length) {
    exStatus(t('playbackEmpty'))
    return
  }
  if (!exSupported()) {
    exStatus(exUnsupportedReason())
    return
  }
  exBusy = true
  exCancel = false
  exResetResult()
  const btn = document.querySelector('#ex-run')
  btn.textContent = t('cancel')
  // The playback shouldn't keep animating and competing for the tile servers
  // while every frame of the export is waiting on them.
  const wasPlaying = pb.playing
  pb.playing = false
  pbRenderToggle()
  try {
    exStatus(t('exportFetching'))
    const legs = await exBuildLegs(pb.trips.slice(), (f) => exProgress(f * 0.15))
    if (!legs.length) {
      exStatus(t('playbackNoTrack'))
      return
    }
    if (exCancel) {
      exStatus('')
      return
    }
    const film = exBuildFilm(legs, EX_SIZES[exSize], pb ? pb.speed : 1)
    exStatus(t('exportRendering')(Math.round(film.timeline.total)))
    const blob = await exEncode(film, (f) => exProgress(0.15 + f * 0.85), () => exCancel)
    if (!blob) {
      exStatus('')
      exProgress(0)
      return
    }
    const name = `${(placeOf(legs[0].trip, 'start') || 'logbook')}-${fmtDate(legs[0].trip.start_time)}`
      .replace(/[^\w\-åäöÅÄÖ]+/g, '-').toLowerCase()
    const file = new File([blob], `${name}.mp4`, { type: 'video/mp4' })
    exProgress(1)
    // Hold the finished file and offer both ways to keep it as separate choices:
    // a plain download, and — where the browser has a share sheet — a Share button
    // beside it (the page can't add a download entry to the sheet itself). Sharing
    // needs a fresh user gesture and the render just spent half a minute, so it can
    // only run from a later tap on that button, never straight from here.
    exResultFile = file
    document.querySelector('#ex-run').hidden = true
    document.querySelector('#ex-actions').hidden = false
    document.querySelector('#ex-share').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }))
    exStatus(t('exportReadyChoose'))
  } catch (e) {
    exStatus(t('error') + e.message)
  } finally {
    exBusy = false
    document.querySelector('#ex-run').textContent = t('exportVideo')
    pb && (pb.playing = wasPlaying)
    if (pb && wasPlaying) {
      pbRenderToggle()
      pbLoop()
    }
  }
}

// Download the held file, then return the panel to idle.
function exDownloadResult () {
  const file = exResultFile
  exDownload(file)
  exStatus(t('exportDone')(Math.round(file.size / 1048576)))
  exResetResult()
}

// Share the finished file on the fresh gesture of a tap. Dismissing the sheet
// (AbortError) leaves the buttons as they are, so it can be tapped again; any
// other failure falls back to a download so the film is never lost.
async function exShareResult () {
  const file = exResultFile
  try {
    await navigator.share({ files: [file] })
    exStatus(t('exportShared'))
    exResetResult()
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return
    }
    exDownload(file)
    exStatus(t('exportDone')(Math.round(file.size / 1048576)))
    exResetResult()
  }
}

// Drop any held result, hide its buttons and clear the progress bar, returning
// the panel to idle.
function exResetResult () {
  exResultFile = null
  document.querySelector('#ex-run').hidden = false
  document.querySelector('#ex-actions').hidden = true
  exProgress(0)
}

// Drop a held result on a settings change, so a stale film isn't left behind the
// buttons after the size it was rendered at has moved on.
function exInvalidateResult () {
  if (exResultFile) {
    exResetResult()
    exStatus('')
  }
}

function exInit () {
  const btn = document.querySelector('#ex-run')
  if (!btn) {
    return
  }
  exRenderSizes()
  if (!exSupported()) {
    btn.disabled = true
    exStatus(exUnsupportedReason())
  }
  // The main button either cancels a running render or starts a new one; the
  // finished film is kept or shared from its own two buttons instead.
  btn.addEventListener('click', () => {
    if (exBusy) {
      exCancel = true
      return
    }
    exRun()
  })
  document.querySelector('#ex-download').addEventListener('click', () => {
    if (exResultFile) {
      exDownloadResult()
    }
  })
  document.querySelector('#ex-share').addEventListener('click', () => {
    if (exResultFile) {
      exShareResult()
    }
  })
}

exInit()
