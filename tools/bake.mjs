// Bakes one Dubai neighbourhood into a single offline JSON: real building
// footprints and real places, both from OpenStreetMap via Overpass.
//
//   node tools/bake.mjs
//
// Raw Overpass responses are cached under tools/.cache so re-runs are free.
// Overpass rate-limits hard (429) and times out on big boxes (504), so every
// request retries with backoff.
//
// Output coordinates are metres east/south of the bbox centre, rounded to
// 10 cm. That is why data/jbr.json is small enough to ship offline.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'tools', '.cache');
const ENDPOINT = 'https://overpass-api.de/api/interpreter';

const AREA = {
  id: 'jbr',
  label: 'Jumeirah Beach Residence',
  // south, west, north, east
  bbox: [25.070, 55.125, 25.090, 55.145],
};

// Hand-written notes for the places we keep. The name, coordinates and opening
// hours all come from OSM; only these one-liners are ours. Anything not listed
// here is dropped, which is how 206 raw POIs become a curated ~28.
const NOTES = {
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
  'P.F. Chang\'s': ['food', 'Lettuce wraps and a long cocktail list.'],
  'Paavo’s Pizza': ['food', 'Runs to 4am at the weekend. Sold by the slice.'],
  'Paavo\'s Pizza': ['food', 'Runs to 4am at the weekend. Sold by the slice.'],
  'Kimuraya': ['food', 'Tiny Japanese counter. Sit at the bar, order the katsu.'],
  'San Wan Hand Pulled Noodles': ['food', 'Noodles pulled to order behind glass. Closes between services.'],
  'Grand Grill Steakhouse': ['food', 'Straightforward steak, no theatre, fair prices.'],
  'Bake My Day': ['cafe', 'Pastry case worth crossing the road for. Open till midnight.'],
  'House of Pops': ['cafe', 'Fruit ice pops, no refined sugar. Good in 40 degree heat.'],
  'The Acai Spot - Dubai Marina B': ['cafe', 'Acai bowls, post-beach queue after five.'],
  'Pechka Cafe and Bakery': ['cafe', 'Eastern European bakery. Coffee and something buttery.'],
  'S’wich': ['cafe', 'Sandwiches until midnight, counter service, no fuss.'],
  'S\'wich': ['cafe', 'Sandwiches until midnight, counter service, no fuss.'],
  'Fresh Fish': ['food', 'Pick from the ice, they grill it. Open till 3am.'],
  'Bar 44': ['bar', 'Forty-fourth floor. Marina panorama, jazz most nights.'],
  'Embassy': ['bar', 'Late and loud. Doors at eight.'],
  'Tandoori Junction': ['food', 'North Indian, generous portions, quick service.'],
  'Awani': ['food', 'Levantine mezze from breakfast to midnight.'],
  'Carluccio’s': ['cafe', 'Italian deli-cafe. Morning only, closes at noon.'],
  'Carluccio\'s': ['cafe', 'Italian deli-cafe. Morning only, closes at noon.'],
  'Stanley': ['food', 'All-day menu, big windows, good for a long lunch.'],
  'Villa Verona': ['food', 'Italian, closes mid-afternoon at the weekend. Check before you walk.'],
  'Sweetheart Kitchen': ['food', 'Delivery kitchen with a hatch. Open 24 hours.'],
  'Smoky Beach': ['bar', 'Feet in the sand, grill smoke, no reservation.'],
  'Jumeirah Lakes Towers Park': ['event', 'Lawns and a running loop. Busiest after sundown.'],
};

async function overpass(name, query) {
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, name + '.json');
  if (existsSync(file)) {
    console.log(`  ${name}: cache hit`);
    return JSON.parse(await readFile(file, 'utf8'));
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(ENDPOINT, { method: 'POST', body: query });
    if (res.ok) {
      const text = await res.text();
      await writeFile(file, text);
      console.log(`  ${name}: fetched ${(text.length / 1024).toFixed(0)} KB`);
      return JSON.parse(text);
    }
    const wait = attempt * 20;
    console.log(`  ${name}: HTTP ${res.status}, retrying in ${wait}s`);
    await new Promise(r => setTimeout(r, wait * 1000));
  }
  throw new Error(`${name}: Overpass failed after 5 attempts`);
}

// Equirectangular projection about the bbox centre. Accurate to well under a
// metre across 2 km, and far cheaper than pulling in a projection library.
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

const buildingQuery = `[out:json][timeout:90];(way["building"](${bb}););out geom;`;

const poiQuery = `[out:json][timeout:90];
(
  nwr["amenity"~"^(restaurant|cafe|fast_food|ice_cream|bar)$"]["name"](${bb});
  nwr["tourism"~"^(attraction|viewpoint|artwork|museum|gallery)$"]["name"](${bb});
  nwr["leisure"~"^(park|garden|beach_resort)$"]["name"](${bb});
  nwr["shop"~"^(mall|bakery)$"]["name"](${bb});
);
out center tags;`;

console.log(`Baking ${AREA.label} (${bb})`);
const rawBuildings = await overpass(`${AREA.id}-buildings`, buildingQuery);
const rawPois = await overpass(`${AREA.id}-pois`, poiQuery);

const proj = projector(AREA.bbox);

// Flat arrays: [height, x0, z0, x1, z1, ...]. Roughly half the bytes of an
// array of {x, y} objects, and it feeds straight into a Three.js Shape.
let withRealHeight = 0;
const buildings = [];
for (const el of rawBuildings.elements) {
  const geom = el.geometry;
  if (!geom || geom.length < 4) continue;
  const real = heightOf(el.tags || {});
  if (real) withRealHeight++;
  // Median JBR height is 98 m, but an unlabelled footprint is usually a low
  // podium or villa, not a tower. 14 m keeps the skyline honest.
  const flat = [real ?? 14];
  // Drop the repeated closing vertex; the renderer closes the shape itself.
  const ring = geom[0].lat === geom.at(-1).lat && geom[0].lon === geom.at(-1).lon
    ? geom.slice(0, -1)
    : geom;
  for (const p of ring) flat.push(...proj.to(p.lat, p.lon));
  if (flat.length >= 7) buildings.push(flat);
}

const spots = [];
const seen = new Set();
for (const el of rawPois.elements) {
  const tags = el.tags || {};
  const entry = NOTES[tags.name];
  if (!entry || seen.has(tags.name)) continue;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) continue;
  seen.add(tags.name);
  const [x, z] = proj.to(lat, lng);
  spots.push({
    id: tags.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name: tags.name,
    kind: entry[0],
    note: entry[1],
    x, z,
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    // Raw OSM opening_hours. null means genuinely unknown, and the UI says so
    // rather than inventing hours.
    hours: tags.opening_hours ?? null,
  });
}

const out = {
  area: AREA.id,
  label: AREA.label,
  bbox: AREA.bbox,
  centre: proj.centre,
  attribution: 'Building footprints and places © OpenStreetMap contributors, ODbL.',
  baked: new Date().toISOString().slice(0, 10),
  buildings,
  spots,
};

await mkdir(join(ROOT, 'data'), { recursive: true });
const path = join(ROOT, 'data', `${AREA.id}.json`);
await writeFile(path, JSON.stringify(out));

const kb = (JSON.stringify(out).length / 1024).toFixed(0);
const missing = spots.filter(s => !s.hours).length;
console.log(`\n  buildings      ${buildings.length} (${withRealHeight} with real height)`);
console.log(`  spots          ${spots.length} (${missing} without opening hours)`);
console.log(`  unmatched      ${Object.keys(NOTES).length - seen.size} notes had no OSM match`);
console.log(`  wrote          data/${AREA.id}.json, ${kb} KB`);
