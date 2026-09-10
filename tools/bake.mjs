// Bakes one Dubai neighbourhood into a single offline JSON: real building
// footprints, real places, and enough real geography that the scene reads as a
// beach rather than a field of grey boxes. All from OpenStreetMap via Overpass.
//
//   node tools/bake.mjs
//
// Raw Overpass responses are cached under tools/.cache so re-runs are free.
// Overpass rate-limits hard (429) and times out on big boxes (504), so every
// request retries with backoff.
//
// Output coordinates are metres east/south of the bbox centre, rounded to
// 10 cm. That is why data/jbr.json stays small enough to ship offline.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'tools', '.cache');
// Mirrors, tried in order. The main instance is frequently saturated and
// answers with a timeout rather than a queue position, so the fast community
// mirror goes first.
const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const AREA = {
  id: 'jbr',
  label: 'Jumeirah Beach Residence',
  // south, west, north, east.
  // The west edge reaches 55.112 deliberately: Bluewaters Island and Ain Dubai
  // sit at 55.1238, and a tighter box cuts the area's one true landmark out.
  bbox: [25.066, 55.112, 25.094, 55.148],
};

// Hand-written notes for the places we keep. Name, coordinates and opening
// hours all come from OSM; only these one-liners are ours. Anything not listed
// is dropped, which is how ~200 raw POIs become a curated set.
const NOTES = {
  'Ain Dubai': ['event', 'The largest observation wheel built. Thirty-eight minutes a rotation.'],
  'Buddha Bar': ['bar', 'Cavernous, red-lit, a giant Buddha over the room. Book or queue.'],
  'Pure Sky Lounge & Dining': ['bar', 'Thirty-five floors up. The whole coastline is the view.'],
  'Dinner In The Sky': ['event', 'A table winched into the air on a crane. Exactly as advertised.'],
  '% Arabica': ['cafe', 'Kyoto roaster, minimalist counter, consistently the best flat white on The Walk.'],
  'Claw BBQ Crabshack Grill - JBR': ['food', 'Mallets, bibs, buckets of crab. Loud and worth it.'],
  'Bliss Lounge': ['bar', 'Beachfront cushions, shisha, sea breeze. Sunset onward.'],
  'The Maine Oyster Bar and Grill': ['food', 'Dark wood brasserie. Oysters and a proper burger.'],
  'Aprons & Hammers': ['food', 'Seafood you smash open yourself. Plastic sheeting on the table.'],
  'Bosporus': ['food', 'Turkish, generous, open past midnight. Get the pide.'],
  'Eat Greek Kouzina': ['food', 'Plate-smashing on busy nights. The saganaki arrives on fire.'],
  'Marbar Rooftop Tapas Bar': ['bar', 'Small rooftop, small plates, marina lights below.'],
  'Shake Shack': ['food', 'Reliable at 2am when nothing else on the beach is.'],
  'Zaatar W Zeit': ['food', 'Manakish around the clock. The cheapest good idea here.'],
  'Buffalo Wild Wings': ['food', 'Screens on every wall. Where the match gets watched.'],
  'P.F. Chang’s': ['food', 'Lettuce wraps and a long cocktail list.'],
  "P.F. Chang's": ['food', 'Lettuce wraps and a long cocktail list.'],
  'Paavo’s Pizza': ['food', 'Runs to 4am at the weekend. Sold by the slice.'],
  "Paavo's Pizza": ['food', 'Runs to 4am at the weekend. Sold by the slice.'],
  'Kimuraya': ['food', 'Tiny Japanese counter. Sit at the bar, order the katsu.'],
  'San Wan Hand Pulled Noodles': ['food', 'Noodles pulled to order behind glass. Closes between services.'],
  'Grand Grill Steakhouse': ['food', 'Straightforward steak, no theatre, fair prices.'],
  'Bake My Day': ['cafe', 'Pastry case worth crossing the road for. Open till midnight.'],
  'House of Pops': ['cafe', 'Fruit ice pops, no refined sugar. Good in 40 degree heat.'],
  'The Acai Spot - Dubai Marina B': ['cafe', 'Acai bowls, post-beach queue after five.'],
  'Pechka Cafe and Bakery': ['cafe', 'Eastern European bakery. Coffee and something buttery.'],
  'S’wich': ['cafe', 'Sandwiches until midnight, counter service, no fuss.'],
  "S'wich": ['cafe', 'Sandwiches until midnight, counter service, no fuss.'],
  'Fresh Fish': ['food', 'Pick from the ice, they grill it. Open till 3am.'],
  'Bar 44': ['bar', 'Forty-fourth floor. Marina panorama, jazz most nights.'],
  'Embassy': ['bar', 'Late and loud. Doors at eight.'],
  'Tandoori Junction': ['food', 'North Indian, generous portions, quick service.'],
  'Awani': ['food', 'Levantine mezze from breakfast to midnight.'],
  'Carluccio’s': ['cafe', 'Italian deli-cafe. Morning only, closes at noon.'],
  "Carluccio's": ['cafe', 'Italian deli-cafe. Morning only, closes at noon.'],
  'Stanley': ['food', 'All-day menu, big windows, good for a long lunch.'],
  'Villa Verona': ['food', 'Italian, closes mid-afternoon at the weekend. Check before you walk.'],
  'Sweetheart Kitchen': ['food', 'Delivery kitchen with a hatch. Open 24 hours.'],
  'Smoky Beach': ['bar', 'Feet in the sand, grill smoke, no reservation.'],
  'Jumeirah Lakes Towers Park': ['event', 'Lawns and a running loop. Busiest after sundown.'],
  'The Beach': ['event', 'Open-air strip along the sand. Cinema, splash pads, late trading.'],
  'JBR Beach': ['event', 'Public sand with the skyline behind and the wheel in front.'],
  'Marina Beach': ['event', 'Quieter end of the same sand. Lifeguarded until sunset.'],
  'Bluewaters Island': ['event', 'Man-made island under the wheel. Restaurants ring the promenade.'],
};

// Roads worth drawing. Anything smaller buries the place markers.
const ROAD_W = {
  motorway: 22, motorway_link: 10, trunk: 18, trunk_link: 9,
  primary: 15, primary_link: 8, secondary: 12, tertiary: 9,
};

async function overpass(name, query) {
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, name + '.json');
  if (existsSync(file)) {
    try {
      const hit = JSON.parse(await readFile(file, 'utf8'));
      console.log(`  ${name}: cache hit`);
      return hit;
    } catch {
      console.log(`  ${name}: cached body is not JSON, refetching`);
    }
  }
  // Shelling out to curl rather than using fetch. Overpass answers 406 to the
  // Content-Type that Node's fetch sends and the alternatives were flaky here,
  // while curl -d works every time. Not worth out-arguing.
  const body = join(CACHE, name + '.query');
  await writeFile(body, query);

  for (let attempt = 1; attempt <= 6; attempt++) {
    const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
    const host = new URL(endpoint).host;
    // curl's own exit code matters as much as the HTTP status: 28 is a client
    // timeout, which these servers earn regularly on a box this size.
    const status = await new Promise(resolve => {
      execFile('curl', ['-s', '-m', '300', '-X', 'POST', '--data-binary', `@${body}`,
        '-o', file, '-w', '%{http_code}', endpoint],
        { maxBuffer: 1 << 20 }, (err, out) => resolve(err ? `curl${err.code}` : out.trim()));
    });

    if (status === '200') {
      const text = await readFile(file, 'utf8');
      // A saturated mirror will hand back an XML error page under HTTP 200.
      // Parse before trusting it, or the bad body gets cached and every later
      // run fails on a file that looks like a successful fetch.
      try {
        const parsed = JSON.parse(text);
        console.log(`  ${name}: ${(text.length / 1024).toFixed(0)} KB from ${host}`);
        return parsed;
      } catch {
        console.log(`  ${name}: ${host} returned ${text.trim().slice(0, 40)}..., not JSON`);
      }
    } else
    // 429 is rate limiting, 504 a server-side timeout, 000/curl28 a stall. All
    // mean "try another mirror" rather than "the query is wrong".
    if (!['429', '504', '000', 'curl28'].includes(status)) {
      throw new Error(`${name}: ${host} returned ${status}, not retrying`);
    }
    console.log(`  ${name}: ${host} gave ${status}, trying next mirror`);
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error(`${name}: every Overpass mirror failed`);
}

// Equirectangular projection about the bbox centre. Sub-metre accurate across a
// few km, and far cheaper than pulling in a projection library.
// NOTE: latitude is negated, so the projected plane is MIRRORED relative to
// geographic space. Anything that depends on handedness (see the coastline
// side-of-line logic below) has to account for that flip.
function projector([south, west, north, east]) {
  const lat0 = (south + north) / 2;
  const lng0 = (west + east) / 2;
  const mPerLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const mPerLat = 110574;
  return {
    centre: [lat0, lng0],
    to: (lat, lng) => [
      Math.round((lng - lng0) * mPerLng * 10) / 10,
      Math.round(-(lat - lat0) * mPerLat * 10) / 10,
    ],
  };
}

function heightOf(tags) {
  const h = parseFloat(tags.height);
  if (Number.isFinite(h) && h > 0) return Math.round(h * 10) / 10;
  const levels = parseFloat(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) return Math.round(levels * 32) / 10;
  return null;
}

const bb = AREA.bbox.join(',');
const proj = projector(AREA.bbox);
const ring = (geom, close = true) => {
  const out = [];
  const pts = close && geom.length > 1
    && geom[0].lat === geom.at(-1).lat && geom[0].lon === geom.at(-1).lon
    ? geom.slice(0, -1) : geom;
  for (const p of pts) out.push(...proj.to(p.lat, p.lon));
  return out;
};

console.log(`Baking ${AREA.label} (${bb})`);

const rawBuildings = await overpass('jbr2-buildings',
  `[out:json][timeout:240];(way["building"](${bb}););out geom;`);

const rawPois = await overpass('jbr2-pois', `[out:json][timeout:240];
(
  nwr["amenity"~"^(restaurant|cafe|fast_food|ice_cream|bar)$"]["name"](${bb});
  nwr["tourism"~"^(attraction|viewpoint|artwork|museum|gallery)$"]["name"](${bb});
  nwr["leisure"~"^(park|garden|beach_resort)$"]["name"](${bb});
  nwr["natural"="beach"]["name"](${bb});
  nwr["place"="island"]["name"](${bb});
  nwr["shop"~"^(mall|bakery)$"]["name"](${bb});
);
out center tags;`);

// Geography. The coastline query uses a wider box than the scene so the strip
// runs past the visible edge instead of stopping short and leaving a seam.
const rawGeo = await overpass('jbr2-geo', `[out:json][timeout:240];
(
  way["natural"="coastline"](25.056,55.102,25.104,55.158);
  way["natural"="beach"](${bb});
  way["natural"="water"](${bb});
  way["leisure"~"^(park|garden)$"](${bb});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](${bb});
  nwr["attraction"="big_wheel"](${bb});
);
out geom tags;`);

// ---- buildings ------------------------------------------------------------
let withRealHeight = 0;
const buildings = [];
for (const el of rawBuildings.elements) {
  if (!el.geometry || el.geometry.length < 4) continue;
  if (el.tags?.attraction === 'big_wheel') continue;   // drawn as a wheel, not a box
  const real = heightOf(el.tags || {});
  if (real) withRealHeight++;
  // Median JBR height is ~98 m, but an unlabelled footprint is usually a low
  // podium or villa rather than a tower. 14 m keeps the skyline honest.
  const flat = [real ?? 14, ...ring(el.geometry)];
  if (flat.length >= 7) buildings.push(flat);
}

// ---- geography ------------------------------------------------------------
const water = [], beach = [], parks = [], roads = [], coast = [];
let wheel = null;

for (const el of rawGeo.elements) {
  const t = el.tags || {};
  const g = el.geometry;

  if (t.attraction === 'big_wheel') {
    const lats = (g || []).map(p => p.lat), lons = (g || []).map(p => p.lon);
    const lat = g ? (Math.min(...lats) + Math.max(...lats)) / 2 : el.lat;
    const lng = g ? (Math.min(...lons) + Math.max(...lons)) / 2 : el.lon;
    const [x, z] = proj.to(lat, lng);
    wheel = { name: t.name || 'Ain Dubai', x, z, height: heightOf(t) ?? 210 };
    continue;
  }
  if (!g || g.length < 2) continue;

  if (t.natural === 'coastline') { coast.push(ring(g, false)); continue; }
  if (t.natural === 'water' && g.length >= 4) { water.push(ring(g)); continue; }
  if (t.natural === 'beach' && g.length >= 4) { beach.push(ring(g)); continue; }
  if ((t.leisure === 'park' || t.leisure === 'garden') && g.length >= 4) { parks.push(ring(g)); continue; }
  if (t.highway && ROAD_W[t.highway]) roads.push([ROAD_W[t.highway], ...ring(g, false)]);
}

// ---- places ---------------------------------------------------------------
const spots = [];
const seen = new Set();
for (const el of rawPois.elements) {
  const t = el.tags || {};
  const entry = NOTES[t.name];
  if (!entry || seen.has(t.name)) continue;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) continue;
  seen.add(t.name);
  const [x, z] = proj.to(lat, lng);
  spots.push({
    id: t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name: t.name,
    kind: entry[0],
    note: entry[1],
    x, z,
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    // Raw OSM opening_hours. null means genuinely unknown, and the UI says so
    // rather than inventing hours.
    hours: t.opening_hours ?? null,
  });
}

// ---- walkable network -----------------------------------------------------
// Routing needs footways and side streets, not just the main roads we draw.
// Nodes are shared by coordinate, so ways that touch actually connect.
const rawWalk = await overpass('jbr2-walk', `[out:json][timeout:240];
(way["highway"~"^(footway|pedestrian|path|steps|living_street|residential|service|unclassified|tertiary|secondary|primary|cycleway)$"](${bb}););
out geom;`);

const nodeIds = new Map();
const nodes = [];
const edges = [];
const nodeAt = (x, y) => {
  // 4 m snap. OSM ways that meet at a junction do share a node id, but geometry
  // output does not carry ids, so snapping is how the graph becomes connected.
  const k = `${Math.round(x / 4)},${Math.round(y / 4)}`;
  if (nodeIds.has(k)) return nodeIds.get(k);
  const i = nodes.length / 2;
  nodes.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
  nodeIds.set(k, i);
  return i;
};
for (const el of rawWalk.elements) {
  const g = el.geometry;
  if (!g || g.length < 2) continue;
  let prev = null;
  for (const p of g) {
    const [x, z] = proj.to(p.lat, p.lon);
    const id = nodeAt(x, z);
    if (prev !== null && prev !== id) edges.push(prev, id);
    prev = id;
  }
}

// ---- land / sea mask ------------------------------------------------------
// Classifying sea by sweeping each coastline segment outward does not work
// here: the coastline arrives as ~3900 fragments facing every direction, and
// the union of the sweeps covers 100% of the scene whichever way you point it.
//
// What does work is local. OSM orients every coastline way with land on one
// consistent side, so for any point the NEAREST segment is the authority on
// which side of the water that point is. Buildings vote to fix which sign means
// land, then the whole area is rasterised once, here, at build time. The
// browser just unpacks a bitmask.
function buildMask() {
  const segs = [];
  for (const w of coast) {
    for (let i = 0; i + 3 < w.length; i += 2) {
      const ax = w[i], az = w[i + 1], dx = w[i + 2] - ax, dz = w[i + 3] - az;
      const l2 = dx * dx + dz * dz;
      if (l2 > 0) segs.push({ ax, az, dx, dz, l2 });
    }
  }
  if (!segs.length) return null;

  // Bucket segments so each lookup tests a handful, not all 3900.
  const CELL = 120;
  const key = (i, j) => `${i},${j}`;
  const grid = new Map();
  for (const s of segs) {
    const i0 = Math.floor(Math.min(s.ax, s.ax + s.dx) / CELL);
    const i1 = Math.floor(Math.max(s.ax, s.ax + s.dx) / CELL);
    const j0 = Math.floor(Math.min(s.az, s.az + s.dz) / CELL);
    const j1 = Math.floor(Math.max(s.az, s.az + s.dz) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(s);
      }
    }
  }

  const sideAt = (px, pz) => {
    let best = Infinity, side = 0;
    for (let r = 1; r <= 24; r++) {
      const ci = Math.floor(px / CELL), cj = Math.floor(pz / CELL);
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          if (r > 1 && Math.abs(i - ci) < r && Math.abs(j - cj) < r) continue;  // ring only
          for (const s of grid.get(key(i, j)) || []) {
            const t = Math.max(0, Math.min(1, ((px - s.ax) * s.dx + (pz - s.az) * s.dz) / s.l2));
            const ex = px - (s.ax + t * s.dx), ez = pz - (s.az + t * s.dz);
            const d2 = ex * ex + ez * ez;
            if (d2 < best) {
              best = d2;
              side = Math.sign(s.dz * (px - s.ax) - s.dx * (pz - s.az));
            }
          }
        }
      }
      // Once something is found, one more ring is enough to beat it.
      if (best < Infinity && best < ((r - 1) * CELL) ** 2) break;
    }
    return side;
  };

  // Which sign means land? Ask the buildings; they are not in the sea.
  let vote = 0;
  for (let i = 0; i < buildings.length; i += 3) {
    const b = buildings[i], n = (b.length - 1) / 2;
    let x = 0, z = 0;
    for (let k = 0; k < n; k++) { x += b[1 + k * 2]; z += b[2 + k * 2]; }
    vote += sideAt(x / n, z / n);
  }
  const landSign = vote >= 0 ? 1 : -1;

  const [south, west, north, east] = AREA.bbox;
  const [, hw] = proj.to(south, east);
  const [halfX] = proj.to(north, east);
  const halfZ = Math.abs(hw);
  const W = 440, H = 440;   // ~8 m cells; coarser than this and the coastline visibly stair-steps
  const spanX = Math.abs(halfX) * 2.4, spanZ = halfZ * 2.4;
  const x0 = -spanX / 2, z0 = -spanZ / 2;
  const stepX = spanX / W, stepZ = spanZ / H;

  const bits = Buffer.alloc(Math.ceil((W * H) / 8));
  let seaCells = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const s = sideAt(x0 + (i + 0.5) * stepX, z0 + (j + 0.5) * stepZ);
      if (s !== 0 && s !== landSign) {                 // sea
        const n = j * W + i;
        bits[n >> 3] |= 1 << (n & 7);
        seaCells++;
      }
    }
  }
  console.log(`  mask        ${W}x${H}, ${(100 * seaCells / (W * H)).toFixed(0)}% sea, ` +
              `land sign ${landSign} (vote ${vote})`);
  return { w: W, h: H, x0, z0, stepX, stepZ, bits: bits.toString('base64') };
}

const seaMask = buildMask();

const out = {
  area: AREA.id,
  label: AREA.label,
  bbox: AREA.bbox,
  centre: proj.centre,
  attribution: 'Buildings, coastline, roads and places © OpenStreetMap contributors, ODbL.',
  baked: new Date().toISOString().slice(0, 10),
  buildings, spots, water, beach, parks, roads, coast, wheel, seaMask,
  walk: { nodes, edges },
};

await mkdir(join(ROOT, 'data'), { recursive: true });
const json = JSON.stringify(out);
await writeFile(join(ROOT, 'data', `${AREA.id}.json`), json);

const missing = spots.filter(s => !s.hours).length;
console.log(`\n  buildings   ${buildings.length} (${withRealHeight} with real height)`);
console.log(`  spots       ${spots.length} (${missing} without opening hours)`);
console.log(`  coastline   ${coast.length} ways`);
console.log(`  water       ${water.length}   beach ${beach.length}   parks ${parks.length}`);
console.log(`  roads       ${roads.length}`);
console.log(`  wheel       ${wheel ? `${wheel.name}, ${wheel.height} m` : 'NOT FOUND'}`);
console.log(`  walk graph  ${nodes.length / 2} nodes, ${edges.length / 2} edges`);
console.log(`  unmatched   ${Object.keys(NOTES).length - seen.size} notes had no OSM match`);
console.log(`  wrote       data/${AREA.id}.json, ${(json.length / 1024).toFixed(0)} KB`);
