# Nearby Radar

Things worth doing around you, right now. Opens at zero bars.

**Live demo:** see the deployment link. **Area:** Jumeirah Beach Residence, Dubai.

Open it in two browsers, set the same crew code, and pin something. It appears
on the other device within a second.

## Key assumptions

The brief contradicts itself twice. We resolved both with architecture rather
than by picking a side.

**"Works with no signal" vs "live updates from friends."** Local-first. The
device store is the source of truth and the whole app, including the map and the
places, ships inside the bundle. Realtime is an overlay on top. Pins made offline
enter an outbox and replay on reconnect instead of failing. Nothing is lost.

**"Logged in, list follows them" vs "no fancy accounts system."** A handle and a
crew code are keys, not an account. No password, no email, no server session.

**"Right now" while offline** cannot mean live data, so we never fake freshness.
Distance and opening hours compute on-device and stay exact. Two of the 34 places
publish no hours, and the app says "hours unknown" rather than inventing any.

**Realtime transport** is a public MQTT relay, so it is not private and keeps no
history. It degrades to same-browser sync if blocked, and the UI names which one
is live.

## How it is built

No build step and no external requests at runtime. Three.js, the MQTT client,
the fonts and the map data are all vendored into the repo, which is why offline
works at all.

`data/jbr.json` is 44 KB holding 341 real building footprints with real heights
and 34 real places with real opening hours, baked from OpenStreetMap by
`tools/bake.mjs`. Re-run it to reproduce the file. The 341 footprints are merged
into a single geometry so the skyline costs one draw call.

```
node tools/bake.mjs        # rebuild data/jbr.json from OpenStreetMap
node tools/test-hours.mjs  # 23 assertions over the real opening_hours strings
npx serve .                # any static server; a service worker needs http(s)
```

Building footprints and places are © OpenStreetMap contributors, ODbL.
