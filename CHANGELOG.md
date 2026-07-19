# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
