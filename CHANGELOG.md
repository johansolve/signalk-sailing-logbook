# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **The track map works without `signalk-to-influxdb`'s `separateLatLon` option.**
  That plugin always writes the position as a JSON string in `jsonValue` and only
  adds separate `lat`/`lon` float fields when that option is switched on, which it
  is not by default. The logbook read nothing but `lat`/`lon`, so on a default
  install every map was empty while the rest of the trip — built from live deltas
  and from the scalar history — looked perfectly normal. It now reads both shapes
  in the same request and merges them per bucket, the floats winning where both
  are there. Merging rather than falling back matters for a database where the
  option was switched on part-way: the floats begin at the flip, and a track,
  a history scan or a retro trip's start position taken from them alone would
  silently begin there too.
  ([#1](https://github.com/johansolve/signalk-sailing-logbook/issues/1))

## [0.10.1] - 2026-08-05

### Added
- **The column abbreviations are spelled out** under the weather table, in both
  languages. STW, TWS, TWD, TWA and AWA are second nature to anyone who has read
  an instrument display for a season and opaque to everyone else, and they head
  the graphs as well as the table.

## [0.10.0] - 2026-08-03

### Added
- **Every hour of the weather table opens into a graph of itself.** Click an hour
  and it unfolds a chartplotter-style history: time running down the box, one
  narrow panel each for STW, TWS and TWD in the table's own column order, drawn
  from the InfluxDB history at one sample per pixel rather than from the hour's
  means, and lightly smoothed (a 45 s centred mean) so sensor hair does not bury
  the shape. Each panel is scaled to
  its own range for that hour (labelled min / mid / max above it), the box always
  covers the full hour so every row's minute scale is the same, and a wind
  veering through north draws as one continuous line instead of falling off the
  top. It is fetched only when the hour is opened.
- **A rolling half hour under the timeline.** The scrubber now carries the same
  three panels, drawn the way the plotter draws them under way: the marker's own
  moment at the top and the half hour behind it running down, each panel headed
  by the value at the marker. It redraws from the track already loaded, so
  dragging the slider costs nothing extra.
- `GET /trips/:id/series` — the history behind that graph: named channels
  (`sog`, `stw`, `tws`, `twd`, `twa`, `awa`, `heel`) over a window inside the
  trip, on one shared time grid. Angles are sampled, never averaged. Read-only,
  like the rest of the read API.

### Fixed
- **A trip at a mooring would not end.** Speed over ground is a poor test of
  stillness: lying to a buoy, GPS noise alone put the 30 s mean at 0.2–0.5 kn on a
  boat that stayed inside 10 metres for an hour, which reset the stop timer every
  few minutes and kept the trip open indefinitely. The longest unbroken stretch
  under the stop threshold was 6 minutes against the 10 required. The position
  trail now gets a vote: when every fix across the stop window lies within
  `stopSpreadMeters` (default 50) of the others, the trip ends, backdated to the
  start of that window. On the trip that prompted this the rule ended it at
  13:20:30, when the boat was 24 m from the buoy she moored to seconds later.
  Speed still ends a trip on its own, so lost or holed position data can never
  keep one open — nor close one, since the rule abstains unless the fixes actually
  cover the window, unless the window lies wholly inside the trip (a stop can
  never predate the start it ends), and unless the speed agrees: a frozen GPS
  repeating one coordinate at 5 kn, or a boat working back and forth in front of
  a bridge, is confined but plainly still under way.
- **A gust at the mooring could start a trip.** The same noise reaches the start
  threshold, and three minutes of it was all the old rule asked for. A start now
  also requires the boat to have gone somewhere: at least half the distance the
  start threshold speed would cover over the last `startMinSeconds`. Swinging
  round a buoy never adds up to that, however long the noise holds. With no
  usable fixes the speed rule decides alone, as before.
- **Rounding up to drop sails logged a tack.** Changing sides is not the same as
  tacking: coming head to wind under engine, the bow wanders across and stays
  there, which on 2026-08-02 recorded a tack going from 5.5° on one side to 5.3°
  on the other, the boat never bearing away onto anything. The engine gate that
  should have caught it was blind — engine state is derived from alternator
  temperature and charge current, and did not report the engine running until two
  minutes later. A maneuver must now also reach a real new tack,
  `newTackMinAwaDeg` (default 20) off the wind, at some point within the hold
  window; reaching it and luffing up again still counts. That angle is read from
  the **apparent** wind, though the side is still read from the true one: the
  masthead measures apparent directly, while true wind is derived from it and the
  speed through water, so a fouled paddlewheel collapses true onto apparent and
  would drag a true-wind threshold down with it — silently rejecting every tack of
  the day, the very failure the speed gate's fallback was written for. It is
  averaged over the same window as the side, since the test asks how far off the
  wind the boat ever got and a single noisy sample would otherwise settle it: the
  manoeuvre this rule exists to reject carried one 20.9° reading, lasting a
  second, in three quarters of a minute otherwise spent inside 8°. The average is
  a vector one, taken as a magnitude afterwards rather than before — a vane
  swinging ±25° across the wind, which is what it does head to wind with the
  genoa flogging, would otherwise read as a steady 25° off it. Where no apparent
  angle is current the requirement lapses rather than condemning on stale
  evidence: a masthead that falls silent as the boat crosses the wind would
  otherwise leave the angle caught mid-crossing standing as the verdict. Each
  maneuver records the angle it was judged by, so one that passed unjudged is
  visible rather than silent. Measured off the wind the threshold only ever bites
  on a tack, since a gybe leaves the boat near dead-downwind anyway — two real
  ones that day, forced by backwinding under a high island, came out at 168.8° and
  148.9° true, and a rule symmetric about the run would have thrown one away. Over
  that day's history it drops five crossings and keeps all four real tacks and
  both gybes.
- **A fouled log silently dropped every manoeuvre of the day.** The minimum-speed
  gate reads speed through water, and a paddle wheel blocked by weed does not fail
  loudly — it reads a flat zero, which the gate takes for a drifting boat and
  suppresses every tack and gybe (a whole passage of them on 2026-08-01). A log
  reading exactly nothing is now taken as a log that is not reading: after 30 s of
  it the gate falls back to speed over ground, and hands back on the first
  positive reading. Any positive reading is trusted however low it looks beside
  SOG, since a current can legitimately hold the log well under the ground track.

## [0.9.3] - 2026-07-30

### Added
- **The map follows the timeline when you have zoomed in.** Scrubbing a stretch of
  the track no longer leaves the boat behind the edge of the frame: as long as the
  view is zoomed in past the whole-track overview, the point stays centred. At the
  overview zoom, where the track is visible end to end anyway, the map stays put.

### Fixed
- **A trip was anchored where the boat was three minutes after it left**, not
  where it started. The start time was correctly backdated to when movement began,
  but the position was read at the moment the start was confirmed, a full
  `startMinSeconds` later and several hundred metres away. A named place within
  `placeRadiusMeters` of the mooring was then missed, the trip fell back to its
  geocoded name, and renaming it planted a second copy of the place. Both ends of
  a trip now take the position that was current at the reported time. The same
  correction applies to the stop, where the error was smaller (the boat is nearly
  stationary through the stop window) but of the same kind.
- **A day of false tacks and gybes.** The wind side was read from the raw wind
  angle, which a masthead unit rolling in old swell swings further and faster
  than the manoeuvre it is meant to reveal — measured at up to 45° between
  consecutive samples in light air, with the boat holding its course to within a
  few degrees. The angle is now averaged over 10 s (circularly, so a run stays a
  run) before the side is read. On the passage that prompted this, 21 recorded
  manoeuvres became 3, which is what the crew sailed. Adjustable as
  `twaSmoothingSeconds`; set it to 0 for the old behaviour.
- **A real tack could go unrecorded.** The minimum-speed gate compared a single
  instantaneous reading from a paddle-wheel log that alternates between the true
  speed and a fraction of it, sampled at the one moment a tack is slowest. It now
  uses the median over the preceding 30 s. The suppression was silent, so the
  manoeuvre simply never appeared.
- **Retrospective scans mistook a dead run for a beat.** History was read as an
  arithmetic mean of wind angles, and the mean of +179° and −179° is 0°. The scan
  now samples the angle instead of averaging it, and reads history at the same
  1 s rate the live path sees, so both paths behave identically.

## [0.9.2] - 2026-07-24

### Added
- **Two more video shapes.** A widescreen 16:9 and a tall 9:16 for phones join the
  squarer 3:4, 1:1 and 4:3, for a clip that has to fit a widescreen player or a
  phone-story frame.
- **Separate Download and Share buttons** once a video is rendered, each with its
  own icon, in place of the single button that guessed which you wanted. On a
  computer the film downloads; where the browser offers a share sheet (a phone, or
  desktop Chrome) Share sits beside it.

### Changed
- Shortened the wording under "Save as video".

### Fixed
- **Playback no longer zooms in too far on a short passage**, which made the boat
  race across the frame. Every leg is now framed no tighter than a fixed patch of
  sea, the same in the live view and in every video shape whatever its aspect
  ratio, so the boat keeps a readable pace however short the trip.
- On a computer a rendered video now offers to download instead of only offering a
  share sheet, which on most desktops had no way to save the file to disk.

## [0.9.1] - 2026-07-23

### Changed
- Reworked the plugin description (shown in the Signal K app store and on npm) to
  lead with passage playback and in-browser video export.

### Fixed
- A trip now closes itself after the boat has lain still for the stop time, even
  at a quay where GPS jitter briefly lifts SOG over the stop threshold. Live
  detection now feeds the trip detector 30 s SOG means, the same smoothing the
  retrospective scan already used, instead of the raw signal whose noise spikes
  kept resetting the stop timer and could leave a trip open indefinitely.

## [0.9.0] - 2026-07-21

### Added
- **Passage playback.** Replays the trips between two dates on the map: the boat
  moves along its recorded track drawing a speed-coloured trail behind it, the
  view follows, and it rests briefly in each port along the way — longer where
  the boat lay overnight, reframing for the next leg while it lies there. It
  leaves a named marker at the departure and at every port it reaches (noting a
  night spent there), so the route ends up labelled with the whole cruise. A
  floating readout beside the
  boat shows speed, an engine badge for the stretches under power, and a trip
  meter running over the whole selected range. An hour under way plays in two
  seconds, adjustable from 0.5× to 4×. The dates default to the season in view,
  so pulling them in gives a single cruise.
- **Save a passage as video.** Renders the playback to an MP4 frame by frame,
  waiting for every chart tile, so the film is identical however slow the
  connection is — not a screen recording. Portrait, square or landscape; the
  boat, its readout and an opening title are drawn in. On a phone the share sheet
  offers the camera roll; elsewhere it downloads. Needs a browser with WebCodecs
  (Chrome, Edge, or Safari 17+); the button explains itself where it is missing.

### Changed
- `dbPath` now defaults to the plugin's own data directory instead of a fixed
  path. If you relied on the old default, set `dbPath` explicitly to keep the
  existing database.

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
