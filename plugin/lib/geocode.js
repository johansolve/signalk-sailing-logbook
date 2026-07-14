/*
 * Reverse geocoding via OpenStreetMap Nominatim. Best-effort and lazy: it runs
 * only when the boat has internet, failures are swallowed, and the resulting
 * name is always just a suggestion the user can override in the webapp.
 *
 * Nominatim's usage policy requires an identifying User-Agent and at most one
 * request per second, so calls are serialised through a shared 1 s throttle.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse'
const USER_AGENT = 'signalk-sailing-logbook (github.com/johansolve)'
const MIN_INTERVAL_MS = 1100

let lastCall = 0
let chain = Promise.resolve()

function throttle () {
  chain = chain.then(async () => {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait))
    }
    lastCall = Date.now()
  })
  return chain
}

// Pick the most specific useful place name from Nominatim's address object,
// preferring marine/harbour features over the raw display_name.
function pickName (data) {
  const a = data.address || {}
  const candidate =
    a.harbour ||
    a.marina ||
    a.hamlet ||
    a.village ||
    a.town ||
    a.suburb ||
    a.city ||
    a.municipality ||
    a.county
  if (candidate) {
    return candidate
  }
  if (data.name) {
    return data.name
  }
  if (data.display_name) {
    return data.display_name.split(',')[0].trim()
  }
  return null
}

// Returns a place-name string, or null if geocoding failed / no connectivity.
async function reverse (lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return null
  }
  try {
    await throttle()
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: 'jsonv2',
      zoom: '14',
      addressdetails: '1'
    })
    const resp = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'sv' },
      signal: AbortSignal.timeout(15000)
    })
    if (!resp.ok) {
      return null
    }
    const data = await resp.json()
    return pickName(data)
  } catch (e) {
    return null
  }
}

module.exports = { reverse }
