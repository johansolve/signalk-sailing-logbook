# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-07-20

### Added
- **Passage playback.** Replays the trips between two dates on the map: the boat
  moves along its recorded track drawing a speed-coloured trail behind it, the
  view follows and eases its zoom to each leg, and it rests briefly in each port
  along the way — longer where the boat lay overnight. A floating readout beside
  the boat shows speed through the water, an engine badge for the stretches under
  power, and a trip meter running over the whole selected range. An hour under
  way plays in two seconds, adjustable from 0.5× to 4×. The dates default to the
  season in view, so pulling them in gives a single cruise.

## [0.8.0] - 2026-07-20

### Added
- **Season filter.** The trip list is filtered by year, defaulting to the most
  recent season that has trips (not the calendar year, which would open on an
  empty list all winter). The chosen year is kept in the URL as `?year=`, so it
  survives opening a trip and coming back, and can be linked. The filter stays
  hidden until there is more than one season to choose between.
- **Season totals** above the list for the year in view: number of trips, total
  distance, total time under way, tacks/gybes, and time under engine with its
  share of the total (shown only when the engine actually ran).

## [0.7.0] - 2026-07-19

### Changed
- **Much faster detail and report loading.** The detail view now loads in parts:
  the trip and its maneuvers render immediately from SQLite while the map and the
  hourly weather load separately, so the page appears at once instead of waiting
  on InfluxDB. The hourly statistics of a completed trip are computed once and
  cached on the trip row (immutable, so never stale), making re-opens and the
  logbook entry near-instant and resilient to a slow or briefly unreachable
  InfluxDB.

### Fixed
- A trip that sailed for over a day before a brief engine use no longer reads as
  fully motoring (engine-state seeding no longer discards a valid old seed).

## [0.6.0] - 2026-07-17

### Added
- **Per-trip notes.** A free-text field on each trip for the skipper's own
  remarks, stored with the trip and included in the copied logbook entry above
  the hourly data. Editing requires an admin login (`PUT /trips/:id/notes`);
  in the web app it is a collapsible panel, opened when the trip already has notes.

### Changed
- The track map now reserves its height at page load (its water backdrop is a
  placeholder), so the content below no longer jumps when the asynchronous track
  resolves. A trip without a track collapses the box as before.

## [0.5.0] - 2026-07-16

### Added
- **Interactive track timeline.** A slider under the map scrubs through the trip,
  moving a highlight dot along the track and updating a fixed info panel with that
  moment's conditions; clicking the track or a maneuver jumps the scrubber there.
- **Map resize handle** to enlarge the map for a closer look (per view, not
  persisted; works with touch).

### Changed
- Trip "max speed" now reports peak STW (boat speed through the water) instead of
  SOG, using the 99th percentile to reject paddle-wheel spikes.
- Refined the report and detail display, and refreshed the screenshot.

## [0.4.0] - 2026-07-15

### Added
- **Track map** for each trip: the route drawn from the InfluxDB position history,
  coloured by boat speed, with tacks/gybes and the start/end marked, on an
  OpenStreetMap base with the OpenSeaMap seamark overlay.
- **Per-hour motoring** detection: hours mostly under engine show a motor badge
  instead of pointing angles, read from `propulsion.<n>.state`.
- **Shared named places**: naming a spot once applies to every trip that starts or
  ends near it, past and future.
- Tests, ESLint and continuous integration.

## [0.1.0] - 2026-07-14

### Added
- Initial release: automatic trip detection from `navigation.speedOverGround`,
  tack/gybe detection from the true wind angle, and hourly wind and heel statistics
  computed on demand from the onboard InfluxDB.
- Retrospective scan to reconstruct past trips from InfluxDB history.
- Bilingual (English / Swedish) web app with a trip list, a detail view, editable
  place names, and a one-click plain-text logbook entry.
