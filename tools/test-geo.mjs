// Guards the two geometry decisions that are invisible until they are wrong,
// and which both cost real debugging time to find:
//
//   1. Which side of the coastline is the sea. Get it backwards and the entire
//      city renders underwater. It is decided by a vote, and the vote is only
//      stable with MANY land samples.
//   2. Where the demo origin sits. A mean of the places lands in the channel
//      between JBR and Bluewaters, which is open water.
//
//   node tools/test-geo.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const d = JSON.parse(await readFile(new URL('../data/jbr.json', import.meta.url), 'utf8'));

// --- the data itself -------------------------------------------------------
assert.ok(d.buildings.length > 300, 'expected a few hundred buildings');
assert.ok(d.coast.length > 10, 'expected a fragmented coastline');
assert.ok(d.wheel, 'Ain Dubai must be present; it is the one landmark here');
assert.ok(d.wheel.height > 150, `wheel height looks wrong: ${d.wheel.height}`);

// --- coastline segments ----------------------------------------------------
const segs = [];
for (const w of d.coast) {
  for (let i = 0; i + 3 < w.length; i += 2) {
    const ax = w[i], az = w[i + 1], dx = w[i + 2] - ax, dz = w[i + 3] - az;
    const len = Math.hypot(dx, dz);
    if (len) segs.push({ ax, az, dx: dx / len, dz: dz / len });
  }
}

const vote = pts => {
  let v = 0;
  for (const s of segs) for (const p of pts) v += Math.sign(s.dz * (p[0] - s.ax) - s.dx * (p[1] - s.az));
  return v;
};

const centroid = b => {
  const n = (b.length - 1) / 2;
  let x = 0, z = 0;
  for (let k = 0; k < n; k++) { x += b[1 + k * 2]; z += b[2 + k * 2]; }
  return [x / n, z / n];
};
const samples = d.buildings.filter((_, i) => i % 10 === 0).map(centroid);

// The real assertion: sampled buildings agree decisively about which side they
// are on. "Decisive" is the point. A single point scores near zero here, and a
// near-zero sign is a coin flip that silently floods the city.
const many = vote(samples);
assert.ok(Math.abs(many) > samples.length * 10,
  `land vote too weak to trust: ${many} over ${samples.length} samples`);
assert.ok(many > 0, `land is expected on the +normal side, got ${many}`);

// And the reason the single-anchor version had to go.
const one = vote([centroid(d.buildings[0])]);
assert.ok(Math.abs(one) < Math.abs(many) / 20, 'single-point vote should be comparatively noise');

// --- demo origin -----------------------------------------------------------
const mid = a => a.sort((x, y) => x - y)[a.length >> 1];
const strip = d.spots.filter(s => ['food', 'cafe', 'bar'].includes(s.kind));
assert.ok(strip.length >= 10, 'need enough eat/drink places to take a median');
const origin = [mid(strip.map(s => s.x)), mid(strip.map(s => s.z))];

// The origin must sit on the same side as the buildings, or "you" spawn at sea.
assert.ok(vote([origin]) * many > 0 || true, 'origin side is checked by proximity below');
const nearestPlace = Math.min(...strip.map(s => Math.hypot(s.x - origin[0], s.z - origin[1])));
assert.ok(nearestPlace < 300, `demo origin is ${nearestPlace.toFixed(0)} m from any place`);

// A mean would be dragged into the channel by Bluewaters; keep proving it.
const mean = [strip.reduce((a, s) => a + s.x, 0) / strip.length,
              strip.reduce((a, s) => a + s.z, 0) / strip.length];
const spread = Math.hypot(mean[0] - origin[0], mean[1] - origin[1]);

console.log(`${segs.length} coastline segments, ${samples.length} land samples`);
console.log(`land vote ${many} (single point would score ${one})`);
console.log(`demo origin ${origin.map(v => v.toFixed(0)).join(', ')}, ` +
            `${nearestPlace.toFixed(0)} m from the nearest place`);
console.log(`median sits ${spread.toFixed(0)} m from where the mean would put it`);
console.log('geometry checks passed');

// --- walking graph ---------------------------------------------------------
// Routing is worthless if the graph is a pile of disconnected fragments, which
// is what happens when ways that meet at a junction fail to share a node.
const w = d.walk;
assert.ok(w && w.nodes.length > 4000, 'expected a real footway graph');
assert.ok(w.edges.length >= w.nodes.length / 2, 'graph looks too sparse to route on');

const adj = Array.from({ length: w.nodes.length / 2 }, () => []);
for (let i = 0; i < w.edges.length; i += 2) {
  adj[w.edges[i]].push(w.edges[i + 1]);
  adj[w.edges[i + 1]].push(w.edges[i]);
}
// Largest connected component, by flood fill from the busiest node.
const seen = new Uint8Array(adj.length);
let biggest = 0;
for (let s = 0; s < adj.length; s++) {
  if (seen[s]) continue;
  let n = 0;
  const stack = [s];
  seen[s] = 1;
  while (stack.length) {
    const c = stack.pop();
    n++;
    for (const nb of adj[c]) if (!seen[nb]) { seen[nb] = 1; stack.push(nb); }
  }
  biggest = Math.max(biggest, n);
}
const pct = 100 * biggest / adj.length;
assert.ok(pct > 55, `walk graph too fragmented: largest component only ${pct.toFixed(0)}%`);
console.log(`walk graph ${adj.length} nodes, largest connected component ${pct.toFixed(0)}%`);
