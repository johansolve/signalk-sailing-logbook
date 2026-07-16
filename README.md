# Sailing Logbook

Just another Automatic Logbook for [Signal K](https://signalk.org/), this one is
focused on sailing performance.

It detects trips from boat speed, marks tacks and gybes, and reports hourly wind
and heel statistics computed on demand from the onboard InfluxDB. A built-in web
app lists your trips and produces a ready-to-paste logbook entry for each one.

![The web app: a trip detail with the speed-coloured track map, the timeline scrubber and its info panel, hourly weather and the maneuver list](docs/screenshot.png)

## Features

- **Automatic trip detection** from `navigation.speedOverGround` with configurable
  speed thresholds and minimum durations (hysteresis, so brief speed spikes don't
  start a trip and a plugin restart doesn't end one).
- **Tack / gybe detection** from `environment.wind.angleTrueWater` (falling back
  to `environment.wind.angleApparent` for a retrospective scan when the
  true-wind derivation logged nothing for that stretch), robust to real-world
  noise:
  - counts a maneuver only if the new tack is held long enough (rejects false
    tacks while hoisting or dropping sails),
  - a dead-run deadband ignores the wind-angle flutter near a dead run,
  - flip-flop tolerance survives a drawn-out maneuver that wanders across the
    wind before settling,
  - a boat-speed gate and a proximity gate (time and distance to the trip
    start/end) drop harbour and mooring turns made under engine,
  - classified by how the boat crossed the wind: over the stern → gybe, over the
    bow → tack.
- **Hourly statistics** from InfluxDB over each trip's exact time window, no data
  duplicated into the plugin: TWS (m/s), STW (kn), TWD (circular mean ± angular
  deviation), TWA, AWA and heel (degrees), each as mean with a p10–p90 range
  (the "significant" min/max, with raw extremes filtered out). TWA/AWA also show
  the dominant tack side.
- **Motoring vs sailing**: reads `propulsion.<n>.state` to drop maneuvers made
  under engine and to flag motoring trips (their report omits tacks/gybes and the
  point-of-sail wording). The engine state comes from a separate provider — this
  plugin does no engine detection of its own (see Requirements).
- **Track map** for each trip: the route drawn from the InfluxDB position
  history, coloured by boat speed, with tacks/gybes and the start/end marked, on
  an OpenStreetMap base with the OpenSeaMap seamark overlay. A timeline slider
  under the map scrubs through the trip, moving a highlight dot along the track
  and updating a fixed info panel with that moment's conditions (SOG/STW,
  TWS/TWD, TWA/AWA, heel, plus an engine badge for the stretches under power);
  clicking the track or a maneuver jumps the scrubber there. Drag the handle
  below the map to enlarge it for a closer look. The map tiles need the network;
  offline, the speed-coloured track still shows on a blank canvas.
- **Place names** via OpenStreetMap Nominatim (best-effort, always editable).
- **Retrospective scan**: reconstruct past trips from InfluxDB history for any
  date range, using the exact same detection logic as live.
- **Web app** with a trip list, a detail view, editable place names, per-maneuver
  deletion, and a one-click plain-text logbook entry to copy.
- **Bilingual** (English / Swedish): follows the browser language, with a
  `?lang=en` / `?lang=sv` override.

## Requirements

- Signal K server with a running InfluxDB 1.x sink
  ([`signalk-to-influxdb`](https://www.npmjs.com/package/signalk-to-influxdb))
  logging at least: `navigation.speedOverGround`, `navigation.speedThroughWater`,
  `navigation.position`, `environment.wind.speedTrue`,
  `environment.wind.angleTrueWater`, `environment.wind.angleApparent`,
  `environment.wind.directionTrue`, `navigation.attitude.roll`.
- **Node.js ≥ 22.5** — storage uses the built-in `node:sqlite`, so there is no
  native module to compile.
- **A `propulsion.<n>.state` provider** (`started` / `stopped`) for the
  motoring/sailing distinction. The logbook reads this path from InfluxDB; it has
  no built-in engine detection. Any of these works:
  - [`signalk-derived-engine-state`](https://www.npmjs.com/package/signalk-derived-engine-state)
    — companion plugin; infers engine state from alternator temperature, charge
    current and wind-vs-speed, and also backfills history. **Recommended.**
  - [`signalk-alternator-engine-on`](https://www.npmjs.com/package/signalk-alternator-engine-on)
    — infers it from alternator power.
  - Native **NMEA 2000 engine data** (PGN 127489), if you have an engine gateway.

  Without a provider the plugin still works; trips just aren't classified as
  motoring and harbour turns under engine may be counted as maneuvers.

## Install

From the Signal K app store, or manually as a file dependency:

```bash
cd ~/signalk-sailing-logbook && npm install
cd ~/.signalk && npm install ../signalk-sailing-logbook   # adds a file: dependency
```

Then enable **Sailing Logbook** in the Signal K plugin config and restart the
server. The SQLite file defaults to `/storage/sailing-logbook/logbook.sqlite`;
point `dbPath` at a writable location (ideally an SSD, not the SD card).

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `dbPath` | `/storage/sailing-logbook/logbook.sqlite` | SQLite file location |
| `startKnots` / `stopKnots` | 0.5 / 0.3 | SOG thresholds to start / stop a trip |
| `startMinSeconds` / `stopMinSeconds` | 180 / 600 | how long the condition must hold |
| `minNewTackSeconds` | 90 | min time on the new tack for a maneuver to count |
| `runDeadbandDeg` | 10 | degrees past dead-downwind before a side counts |
| `minSailingSpeedKnots` | 2 | min boat speed (STW) for a maneuver to count |
| `maneuverEdgeMarginMinutes` | 5 | ignore maneuvers within N minutes of trip start/end |
| `maneuverEdgeRadiusMeters` | 200 | ignore maneuvers within N metres of the start/end |
| `geocode` | true | look up place names via Nominatim |
| `influxHost` / `influxPort` / `database` | localhost / 8086 / libelle | InfluxDB connection |
| `username` / `password` | — | InfluxDB auth (blank if disabled) |

## Web app

Served at `http://<server>:3000/signalk-sailing-logbook/` and from the Signal K
admin **Webapps** menu.

- Reading (trip list, detail, report) works for anonymous users when the server
  allows readonly access.
- Editing place names, deleting trips/maneuvers, and running a history scan
  require an admin login.

## HTTP API

Read (honour readonly access), under `/signalk/v1/api/sailing-logbook`:

- `GET /trips` — list trips with tack/gybe counts
- `GET /trips/:id` — trip detail with hourly statistics
- `GET /trips/:id/track` — downsampled position+SOG track for the map
- `GET /trips/:id/report?lang=en|sv` — plain-text logbook entry

Admin only, under `/plugins/signalk-sailing-logbook`:

- `PUT /trips/:id/place` — set manual start/end place names
- `DELETE /trips/:id` — delete a trip
- `DELETE /events/:id` — delete a single maneuver
- `POST /scan` — `{ from, to }` (ms epoch): retrospectively detect trips

## How it works

The plugin persists only *events* (trip start/stop, tack/gybe markers with their
position) to SQLite. All hourly statistics are derived from InfluxDB on demand
over the trip's `[start, stop]` window, so nothing is duplicated and the numbers
are never stale. The queries are time-bounded, which also excludes the occasional
mis-timestamped GPS point some NMEA sources emit.

Live detection feeds the state machine one sample at a time using server receive
time; retrospective scanning replays the InfluxDB history through the exact same
state machine.

## License

MIT
