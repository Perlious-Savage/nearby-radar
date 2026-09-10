# Nearby Radar

Things worth doing around you, right now. Opens at zero bars.

**Run:** open `index.html`, or any static server. Two tabs = two people on a crew.

## Assumptions we made

The brief contradicts itself twice. We resolved both with architecture, not by picking a side.

**"Works with no signal" vs "live updates from friends."** We went local-first. The device store is the source of truth and the catalog ships inside the app, so it opens with real content offline. Realtime is an overlay on top. Pins made offline queue and replay on reconnect rather than failing. Hit *simulate offline* to watch it.

**"Logged in, list follows them" vs "no fancy accounts system."** A handle is a key, not an account. No password, no email, no server. Your saved list is keyed to the handle and survives reloads.

**"Stuff happening right now" while offline** is impossible, so we never fake freshness. The catalog carries its own age and the app says plainly when data is cached.

**Realtime transport** is `BroadcastChannel`, same-origin cross-tab. No backend was shippable in the time. The sync layer is transport-agnostic.

Crew activity from `maya`, `rehan` and others is seeded demo data.

No dependencies. No build step.
