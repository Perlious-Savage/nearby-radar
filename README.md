# Nearby Radar

Things worth doing around you, right now. Opens at zero bars.

**Live demo:** see the deployment link. **Area:** Jumeirah Beach Residence, Dubai.

Open it in two browsers, set the same crew code, and pin something. It appears
on the other device within a second.

## Key assumptions

The brief contradicts itself twice. We resolved both with architecture rather
than by picking a side.

**Anyone can add a place.** A fixed catalogue cannot express a pop-up, a busker
or a queue worth joining, which is most of what "friends find something cool"
means. Hit *Add a place*, click the map, name it. It syncs to your crew.

**"Works with no signal" vs "live updates from friends."** Local-first. The
device store is the source of truth and the whole app, including the map and the
places, ships inside the bundle. Realtime is an overlay on top. Pins made offline
enter an outbox and replay on reconnect instead of failing. Nothing is lost.

**"Logged in, list follows them" vs "no fancy accounts system."** A handle and a
crew code are keys, not an account. No password, no email, no server session.

**"Right now" while offline** cannot mean live data, so we never fake freshness.
Distance and opening hours compute on-device and stay exact. Three of the 36 places
publish no hours, and the app says "hours unknown" rather than inventing any.

**Realtime transport** is a public MQTT relay, so it is not private. Pins are
moments and are not retained. Places people add are facts about the map, so each
goes to its own topic with the retain flag, which is how someone opening the link
late still receives every place added before they arrived. If the relay is
blocked the app degrades to same-browser sync, and the UI names which one is
live rather than hiding it.

**Walking directions** are A* over a footway graph baked from OpenStreetMap:
15,868 nodes and 17,099 edges, all offline. Where no mapped path exists the app
says so and gives a straight-line distance and bearing instead of drawing a line
through buildings and calling it directions.

## How it is built

No build step and no external requests at runtime. Three.js, the MQTT client,
the fonts and the map data are all vendored into the repo, which is why offline
works at all.

`data/jbr.json` is 217 KB of OpenStreetMap, baked by `tools/bake.mjs`: 634
building footprints at their real heights, 36 real places with real opening
hours, the coastline, the beaches, the parks, the main roads, and Ain Dubai at
its tagged 210 m. Re-run the script to reproduce it.

Two things in there are worth knowing. All 634 footprints are merged into one
geometry, so the skyline costs a single draw call. And land versus sea is a
baked bitmask: for every 10 m cell, which side of the *nearest* coastline
segment it falls on. Sweeping each segment outward instead does not work, since
the coastline arrives as 3,893 fragments facing every direction and the union
covers the whole scene whichever way you point it.

```
node tools/bake.mjs        # rebuild data/jbr.json from OpenStreetMap
node tools/test-hours.mjs  # 23 assertions over the real opening_hours strings
node tools/test-geo.mjs    # land/sea classification, demo origin, walk graph
npx serve .                # any static server; a service worker needs http(s)
```

Building footprints and places are © OpenStreetMap contributors, ODbL.
