// Nearby Radar. Local-first: the device store is the source of truth and
// realtime is an overlay on top of it.
//
// The brief contradicted itself twice. Both are resolved by architecture, not
// by picking a side:
//   "no signal" vs "live friend updates" -> local store is truth, every
//      mutation lands locally first and enters an outbox that replays on
//      reconnect. Nothing is ever lost to a dead connection.
//   "logged in" vs "no accounts system" -> a handle and a crew code are keys,
//      not an account. No password, no email, no server session.

import { City } from './city.js';
import { openState } from './hours.js';

const KEY = 'nearby.v2';
// Everyone who opens the link without a #crew= lands here, so one upload is
// visible to every visitor. A random default meant the plain link put each
// person alone in an empty crew, which is not what "shared" means. Private
// crews still exist: any other code, reached by an Invite link, is separate.
const PUBLIC_CREW = 'JBR';

const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];

const $ = id => document.getElementById(id);
const el = {};
for (const id of ['net', 'netName', 'who', 'crew', 'canvas', 'cards', 'feed', 'stale',
  'rNear', 'rOpen', 'rSaved', 'rQueue', 'shell', 'fallback', 'detail', 'dName',
  'dMeta', 'dNote', 'dDist', 'dClose', 'dSave', 'dPin', 'sheet',
  'addBtn', 'addForm', 'afName', 'afNote', 'afCancel', 'afSave', 'hint',
  'dNav', 'dRoute', 'dShots', 'dPhoto', 'photoFile', 'inviteBtn']) el[id] = $(id);

// ---------------------------------------------------------------- state
const blank = { handle: '', crew: '', saved: {}, heat: {}, outbox: [], seen: [], added: {} };
let S;
try { S = { ...blank, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
catch { S = { ...blank }; }

const save = () => {
  try {
    // Keep the dedupe ledger bounded; it only needs to outlive a reconnect.
    if (S.seen.length > 400) S.seen = S.seen.slice(-200);
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch (e) { console.warn('storage unavailable', e); }
};

let DATA, city, you = { x: 0, z: 0, real: false };
// The baked catalogue plus anything anyone has dropped on the map since.
const allSpots = () => DATA ? [...DATA.spots, ...Object.values(S.added)] : [];
let filter = 'all';
let query = '';
let selected = null;
let placing = false;
let pendingAt = null;   // where the new place will land, set by clicking the map
let feedItems = [];

// ---------------------------------------------------------------- identity
const rand = n => Math.random().toString(36).slice(2, 2 + n).toUpperCase();

function identity() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('crew')) S.crew = hash.get('crew').toUpperCase().slice(0, 6);
  if (!S.crew) S.crew = PUBLIC_CREW;
  if (!S.handle) S.handle = 'guest' + Math.floor(Math.random() * 900 + 100);
  save();
  el.who.textContent = S.handle;
  el.crew.textContent = S.crew === PUBLIC_CREW ? `${S.crew} - public` : S.crew;
}

el.who.onclick = () => {
  const v = prompt('Handle. No password, no email, it just keys your saved list.', S.handle);
  if (v?.trim()) { S.handle = v.trim().slice(0, 16).toLowerCase(); save(); el.who.textContent = S.handle; }
};

// Everyone who opens the bare link gets their OWN random crew code and so sees
// nobody. Sharing has to carry the code, which is what this copies. Without it
// the whole social half of the app silently does nothing for a new visitor.
const inviteLink = () => `${location.origin}${location.pathname}#crew=${S.crew}`;

el.inviteBtn.onclick = async () => {
  const link = inviteLink();
  try {
    await navigator.clipboard.writeText(link);
    el.inviteBtn.textContent = 'Link copied';
  } catch {
    // Clipboard needs a secure context and permission; fall back to showing it.
    prompt('Share this link. Anyone who opens it joins crew ' + S.crew, link);
    el.inviteBtn.textContent = 'Invite';
    return;
  }
  log('you', `invite link copied, crew ${S.crew}`);
  setTimeout(() => { el.inviteBtn.textContent = 'Invite'; }, 2200);
};

el.crew.onclick = () => {
  const v = prompt('Crew code. Anyone who types the same code shares your live feed.', S.crew);
  if (v?.trim()) {
    S.crew = v.trim().toUpperCase().slice(0, 6);
    save();
    el.crew.textContent = S.crew === PUBLIC_CREW ? `${S.crew} - public` : S.crew;
    transport.restart();
  }
};

// ---------------------------------------------------------------- transport
// One interface, three implementations, tried in order. The UI names whichever
// one is live, so a fallback on bad venue wifi is visible rather than hidden.
const transport = {
  mode: 'connecting',
  client: null,
  bc: null,
  onPin: () => {},
  onSpot: () => {},
  onPhoto: () => {},

  base() { return `nearby/crew/${S.crew}`; },

  start() {
    this.bc = 'BroadcastChannel' in self ? new BroadcastChannel('nearby.crew') : null;
    if (this.bc) this.bc.onmessage = e => this.receive(e.data, 'local');
    this.tryBroker(0);
  },

  tryBroker(i) {
    if (i >= BROKERS.length || !window.mqtt) return this.degrade();
    this.setMode('connecting', BROKERS[i].split('//')[1].split(':')[0]);
    let settled = false;
    const c = window.mqtt.connect(BROKERS[i], {
      clientId: 'nr_' + rand(8),
      connectTimeout: 6000,
      reconnectPeriod: 0,
      keepalive: 30,
    });
    const fail = () => {
      if (settled) return;
      settled = true;
      try { c.end(true); } catch {}
      this.tryBroker(i + 1);
    };
    c.on('connect', () => {
      settled = true;
      this.client = c;
      c.subscribe(`${this.base()}/#`);
      this.setMode('live', BROKERS[i].split('//')[1].split(':')[0]);
      drain();
    });
    c.on('message', (_t, payload) => {
      try { this.receive(JSON.parse(payload.toString()), 'remote'); } catch {}
    });
    c.on('error', fail);
    c.on('close', () => { if (settled && this.client === c) this.degrade(); else fail(); });
  },

  degrade() {
    this.client = null;
    this.setMode(this.bc ? 'local' : 'offline', this.bc ? 'this browser only' : 'no transport');
  },

  restart() {
    try { this.client?.end(true); } catch {}
    this.client = null;
    this.tryBroker(0);
  },

  setMode(mode, name) {
    this.mode = mode;
    el.net.dataset.mode = mode;
    el.netName.textContent = { live: name, connecting: 'connecting', local: 'local only', offline: 'offline' }[mode];
    renderReadout();
  },

  up() { return this.mode === 'live' && navigator.onLine; },

  send(msg) {
    // A pin is a moment and is not retained. A place someone added is a fact
    // about the map, so it goes to its own topic with the retain flag: the
    // broker holds the last message per topic and hands the whole set to
    // whoever subscribes next. That is what gives late joiners any history at
    // all, since the relay stores nothing else.
    const topic = msg.t === 'spot' ? `${this.base()}/spot/${msg.spot.id}`
                : msg.t === 'photo' ? `${this.base()}/photo/${msg.shot.id}`
                : `${this.base()}/pin`;
    if (this.client && navigator.onLine) {
      this.client.publish(topic, JSON.stringify(msg), { retain: msg.t !== 'pin', qos: 0 });
      this.bc?.postMessage(msg);
      return true;
    }
    if (this.bc && this.mode === 'local') { this.bc.postMessage(msg); return true; }
    return false;
  },

  receive(msg, via) {
    if (!msg?.id || msg.from === S.handle) return;
    if (S.seen.includes(msg.id)) return;          // replays are idempotent
    S.seen.push(msg.id);
    if (msg.t === 'spot') this.onSpot(msg, via);
    else if (msg.t === 'photo') this.onPhoto(msg, via);
    else this.onPin(msg, via);
  },
};

// ---------------------------------------------------------------- outbox
function enqueue(msg) {
  if (transport.send(msg)) return 'sent';
  S.outbox.push(msg);
  save();
  return 'queued';
}

function drain() {
  if (!S.outbox.length) return;
  const pending = [...S.outbox];
  const stuck = [];
  for (const m of pending) if (!transport.send(m)) stuck.push(m);
  const flushed = pending.length - stuck.length;
  S.outbox = stuck;
  save();
  if (flushed) {
    log('you', `back online, replayed ${flushed} queued pin${flushed > 1 ? 's' : ''}`);
    render();
  }
}

addEventListener('online', () => { transport.restart(); });
addEventListener('offline', () => { transport.setMode('offline', 'no signal'); });

// ---------------------------------------------------------------- actions
function pin(spot) {
  S.heat[spot.id] = (S.heat[spot.id] || 0) + 1;
  const msg = { id: rand(10), from: S.handle, spot: spot.id, at: Date.now() };
  const how = enqueue(msg);
  save();
  city?.ping(spot.id);
  log('you', how === 'queued' ? `queued a pin for ${spot.name}` : `pinned ${spot.name}`, how === 'queued');
  render();
}

function toggleSave(spot) {
  if (S.saved[spot.id]) delete S.saved[spot.id];
  else S.saved[spot.id] = Date.now();
  save();
  log('you', `${S.saved[spot.id] ? 'saved' : 'unsaved'} ${spot.name}`);
  render();
}

// Anyone can drop a place anywhere. This is the half of "friends find
// something cool" that a fixed catalogue cannot express: a pop-up, a busker, a
// queue worth joining, none of which are in OpenStreetMap.
function addSpot(name, note, x, z) {
  const spot = {
    id: 'live-' + rand(6).toLowerCase(),
    name: name.slice(0, 48),
    kind: 'live',
    note: (note || 'Added live.').slice(0, 140),
    x, z, hours: null,
    by: S.handle,
    at: Date.now(),
  };
  S.added[spot.id] = spot;
  save();
  city?.setSpots(allSpots());
  const how = enqueue({ t: 'spot', id: rand(10), from: S.handle, spot, at: spot.at });
  log('you', how === 'queued' ? `queued "${spot.name}" for the crew` : `added "${spot.name}"`,
      how === 'queued');
  city?.ping(spot.id);
  render();
  return spot;
}

transport.onSpot = (msg) => {
  const spot = msg.spot;
  if (!spot?.id || S.added[spot.id]) return;
  S.added[spot.id] = spot;
  save();
  city?.setSpots(allSpots());
  city?.ping(spot.id);
  log(msg.from, `added "${spot.name}"`);
  render();
};

transport.onPin = (msg) => {
  const spot = allSpots().find(s => s.id === msg.spot);
  if (!spot) return;
  S.heat[spot.id] = (S.heat[spot.id] || 0) + 1;
  save();
  city?.ping(spot.id);
  log(msg.from, `pinned ${spot.name}`);
  render();
};

// ---------------------------------------------------------------- feed
function log(who, text, queued) {
  feedItems.unshift({ who, text, at: Date.now(), queued: !!queued });
  if (feedItems.length > 12) feedItems.pop();
  renderFeed();
}

const ago = t => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

function renderFeed() {
  el.feed.innerHTML = feedItems.length
    ? feedItems.map(f => `<li${f.queued ? ' class="q"' : ''}>
        <span class="hand">${esc(f.who)}</span>
        <span class="txt">${esc(f.text)}</span>
        <span class="ago">${ago(f.at)}</span></li>`).join('')
    : '<li class="empty">Nothing from the crew yet. Pin something.</li>';
}
setInterval(renderFeed, 20000);

// ---------------------------------------------------------------- ranking
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dist = s => Math.hypot(s.x - you.x, s.z - you.z);
const fmtDist = m => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

function score(s) {
  const st = openState(s.hours);
  const d = dist(s);
  let v = 1000 - d / 3;
  if (st?.open) v += 400;
  if (st && !st.open) v -= 250;
  if (st?.open && st.closesIn < 60) v -= 120;      // about to close is less useful
  v += (S.heat[s.id] || 0) * 90;
  if (S.saved[s.id]) v += 60;
  return v;
}

function visible() {
  return allSpots()
    .filter(s => {
      if (query) {
        const hay = `${s.name} ${s.note} ${s.kind}`.toLowerCase();
        if (!query.split(/\s+/).every(w => hay.includes(w))) return false;
      }
      if (filter === 'all') return true;
      if (filter === 'open') return openState(s.hours)?.open === true;
      if (filter === 'saved') return !!S.saved[s.id];
      return s.kind === filter;
    })
    .sort((a, b) => score(b) - score(a));
}

// ---------------------------------------------------------------- render
function card(s) {
  const st = openState(s.hours);
  const heat = S.heat[s.id] || 0;
  const saved = !!S.saved[s.id];
  const queued = S.outbox.some(m => m.spot === s.id);
  const status = st === null
    ? '<span class="unknown">hours unknown</span>'
    : st.open
      ? `<span class="open">open${st.closesIn < 90 ? `, closes in ${st.closesIn} min` : ''}</span>`
      : '<span class="shut">closed now</span>';

  return `<article class="card${saved ? ' is-saved' : ''}" data-spot="${s.id}">
    <div class="card-in">
      ${coverHTML(s)}
      <p class="meta"><span class="kind k-${s.kind}">${s.kind}</span>${status}
        <span class="dist">${fmtDist(dist(s))}</span></p>
      <p class="note">${esc(s.note)}</p>
      ${heat ? `<p class="heat">${heat} crew pin${heat > 1 ? 's' : ''}</p>` : ''}
      <div class="acts">
        <button data-act="save" class="${saved ? 'on' : ''}">${saved ? 'Saved' : 'Save'}</button>
        <button data-act="pin" class="${queued ? 'queued' : ''}">${queued ? 'Queued' : 'Pin for crew'}</button>
      </div>
    </div>
  </article>`;
}

function renderReadout() {
  const near = allSpots().filter(s => dist(s) < 1000).length;
  const open = allSpots().filter(s => openState(s.hours)?.open).length;
  el.rNear.textContent = near;
  el.rOpen.textContent = open;
  el.rSaved.textContent = Object.keys(S.saved).length;
  el.rQueue.textContent = S.outbox.length;

  const known = DATA.spots.filter(s => s.hours).length;
  el.stale.textContent = transport.up()
    ? `Everything here is on your device. ${known} of ${DATA.spots.length} places publish real opening hours; the rest say so. Crew activity is live.`
    : `No live connection, so this is the copy on your device. Distances and opening hours are still exact. Nothing new has arrived from the crew since you dropped.`;
}

function render() {
  el.cards.innerHTML = visible().map(card).join('') || '<p class="empty">Nothing matches.</p>';
  renderReadout();
  city?.updateMarkers(S.heat, new Set(Object.keys(S.saved)));
  if (selected) renderDetail(selected);
}

function renderDetail(s) {
  const st = openState(s.hours);
  el.dName.textContent = s.name;
  el.dMeta.textContent = s.kind;
  el.dNote.textContent = s.note;
  el.dDist.textContent = fmtDist(dist(s));
  el.dClose.textContent = st === null ? 'hours unknown' : st.open
    ? (st.closesIn < 90 ? `closes in ${st.closesIn} min` : 'open now') : 'closed now';
  el.dRoute.hidden = true;
  city?.showRoute(null);
  el.dMeta.textContent = s.kind === 'live' ? `added by ${s.by || 'the crew'}` : s.kind;
  el.dShots.innerHTML = coverHTML(s) + (shotsHTML(s.id) ||
    '<p class="noshots">No photos yet. Add the first one.</p>');
  el.dSave.textContent = S.saved[s.id] ? 'Saved' : 'Save';
  el.dSave.classList.toggle('on', !!S.saved[s.id]);
  el.sheet.hidden = false;
}

// ---------------------------------------------------------------- events
el.cards.addEventListener('click', e => {
  const art = e.target.closest('[data-spot]');
  if (!art) return;
  const spot = allSpots().find(s => s.id === art.dataset.spot);
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'save') return toggleSave(spot);
  if (act === 'pin') return pin(spot);
  selected = spot;
  city?.flyTo(spot);
  renderDetail(spot);
});

el.dSave.onclick = () => selected && toggleSave(selected);
el.dPin.onclick = () => selected && pin(selected);
$('dClose2').onclick = () => {
  el.sheet.hidden = true;
  el.dRoute.hidden = true;
  selected = null;
  city?.showRoute(null);
  city?.pullBack();
};

const search = $('search');
$('searchBtn').onclick = () => {
  const open = search.hasAttribute('hidden');
  search.hidden = !open;
  $('searchBtn').setAttribute('aria-pressed', String(open));
  if (open) search.focus();
  else if (query) { query = ''; search.value = ''; render(); }
};
search.oninput = () => { query = search.value.trim().toLowerCase(); render(); };
search.onkeydown = e => { if (e.key === 'Escape') $('searchBtn').click(); };

document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
  filter = b.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(o => o.setAttribute('aria-pressed', String(o === b)));
  render();
});

// ---------------------------------------------------------------- photos
// Photos live in IndexedDB, not localStorage. A handful of images blows past
// the ~5 MB string quota, and losing someone's photo silently is the worst
// possible failure for the one feature they contributed themselves.
const PDB = 'nearby.photos';
let photos = {};    // spotId -> [{id, spot, url, by, at}]

const openDB = () => new Promise((res, rej) => {
  const r = indexedDB.open(PDB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore('shots', { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

async function savePhoto(p) {
  try {
    const d = await openDB();
    await new Promise((res, rej) => {
      const t = d.transaction('shots', 'readwrite');
      t.objectStore('shots').put(p);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  } catch (e) { console.warn('photo store unavailable', e); }
  (photos[p.spot] ||= []).push(p);
}

async function loadPhotos() {
  try {
    const d = await openDB();
    const all = await new Promise((res, rej) => {
      const q = d.transaction('shots').objectStore('shots').getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    photos = {};
    for (const p of all) (photos[p.spot] ||= []).push(p);
  } catch (e) { console.warn('photos unreadable', e); }
}

// Phone photos are 3-8 MB. Downscale before anything else touches them: the
// relay has a payload ceiling and the outbox has to survive in localStorage.
function shrink(file, max = 720, quality = 0.62) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => rej(new Error('not an image'));
    img.src = URL.createObjectURL(file);
  });
}

async function addPhoto(spot, file) {
  let url;
  try { url = await shrink(file); }
  catch { log('you', 'that file was not an image'); return; }

  const shot = { id: 'p-' + rand(8).toLowerCase(), spot: spot.id, url, by: S.handle, at: Date.now() };
  await savePhoto(shot);
  const how = enqueue({ t: 'photo', id: rand(10), from: S.handle, shot, at: shot.at });
  log('you', how === 'queued'
    ? `queued a photo of ${spot.name}` : `added a photo of ${spot.name}`, how === 'queued');
  render();
}

transport.onPhoto = async (msg) => {
  const shot = msg.shot;
  if (!shot?.id || (photos[shot.spot] || []).some(p => p.id === shot.id)) return;
  await savePhoto(shot);
  const spot = allSpots().find(s => s.id === shot.spot);
  log(msg.from, `added a photo of ${spot ? spot.name : 'a place'}`);
  render();
};

// Deterministic hue per place, so a card looks the same on every device and
// every reload. Cheap, offline, and honestly not a photograph.
const hueOf = id => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

// Seed imagery so a card is never blank before anyone has contributed. These
// are generic stock shots by category, NOT photographs of the venue, and the
// cover labels them "stock" so nobody is misled. A real photo from the crew
// always wins and drops the label.
const SEED = {
  food:  ['food1', 'food2', 'food3', 'food4', 'food5'],
  cafe:  ['cafe1', 'cafe2', 'cafe3'],
  bar:   ['bar1', 'bar2'],
  event: ['event1', 'event2'],
  shop:  ['food3', 'cafe2'],
  live:  ['event2', 'food1'],
};
const seedFor = s => {
  const pool = SEED[s.kind] || SEED.food;
  return `photos/${pool[hueOf(s.id) % pool.length]}.jpg`;
};

const coverHTML = s => {
  const shots = photos[s.id] || [];
  const label = `<span class="covname">${esc(s.name)}</span>`;
  const badge = shots.length > 1 ? `<span class="covcount">${shots.length}</span>` : '';
  if (shots.length) {
    return `<div class="cover"><img src="${shots[shots.length - 1].url}" alt="${esc(s.name)}">${label}${badge}</div>`;
  }
  return `<div class="cover" style="--h:${hueOf(s.id)}">
    <img src="${seedFor(s)}" alt="" loading="lazy" onerror="this.remove();this.parentNode.classList.add('art')">
    <span class="covkind">${s.kind}</span><span class="covstock">stock</span>${label}</div>`;
};

const shotsHTML = (spotId, limit = 6) => {
  const list = (photos[spotId] || []).slice(-limit).reverse();
  if (!list.length) return '';
  return `<div class="shots">${list.map(p =>
    `<figure><img src="${p.url}" alt="" loading="lazy"><figcaption>${esc(p.by)}</figcaption></figure>`
  ).join('')}</div>`;
};

// ---------------------------------------------------------------- add a place
function setPlacing(on) {
  placing = on;
  el.addBtn.setAttribute('aria-pressed', String(on));
  el.addBtn.textContent = on ? 'Cancel' : '+ Add a place';
  el.hint.hidden = !on;
  if (!on) { el.addForm.hidden = true; pendingAt = null; }
}

el.addBtn.onclick = () => setPlacing(!placing);

el.afCancel.onclick = () => setPlacing(false);

el.afSave.onclick = () => {
  const name = el.afName.value.trim();
  if (!name || !pendingAt) { el.afName.focus(); return; }
  const spot = addSpot(name, el.afNote.value.trim(), pendingAt.x, pendingAt.z);
  el.afName.value = el.afNote.value = '';
  setPlacing(false);
  selected = spot;
  city?.flyTo(spot);
  renderDetail(spot);
};

// Enter saves, Escape backs out. Cheaper than a keyboard-handling library and
// it is what anyone will try first.
el.addForm.addEventListener('keydown', e => {
  if (e.key === 'Enter') el.afSave.click();
  if (e.key === 'Escape') setPlacing(false);
});

// ---------------------------------------------------------------- walking route
// A* over the baked footway graph. Straight-line distance is the heuristic,
// which is admissible on a metric graph, so the first path found is shortest.
let adjacency = null;

function graph() {
  if (adjacency) return adjacency;
  const w = DATA.walk;
  if (!w || !w.edges.length) return (adjacency = { adj: [], nodes: [] });
  const adj = Array.from({ length: w.nodes.length / 2 }, () => []);
  for (let i = 0; i < w.edges.length; i += 2) {
    const a = w.edges[i], b = w.edges[i + 1];
    const cost = Math.hypot(w.nodes[a * 2] - w.nodes[b * 2], w.nodes[a * 2 + 1] - w.nodes[b * 2 + 1]);
    adj[a].push([b, cost]);
    adj[b].push([a, cost]);
  }
  return (adjacency = { adj, nodes: w.nodes });
}

const nearestNode = (nodes, x, z) => {
  let best = Infinity, at = -1;
  for (let i = 0; i < nodes.length; i += 2) {
    const d = (nodes[i] - x) ** 2 + (nodes[i + 1] - z) ** 2;
    if (d < best) { best = d; at = i / 2; }
  }
  return at;
};

function route(from, to) {
  const { adj, nodes } = graph();
  if (!adj.length) return null;
  const start = nearestNode(nodes, from.x, from.z);
  const goal = nearestNode(nodes, to.x, to.z);
  if (start < 0 || goal < 0 || start === goal) return null;

  const h = i => Math.hypot(nodes[i * 2] - nodes[goal * 2], nodes[i * 2 + 1] - nodes[goal * 2 + 1]);
  const g = new Float64Array(adj.length).fill(Infinity);
  const came = new Int32Array(adj.length).fill(-1);
  const done = new Uint8Array(adj.length);
  g[start] = 0;

  // Binary min-heap keyed on f. Scanning the open set linearly instead cost
  // about a second on a 1.7 km route, which is a visible freeze, because the
  // walkable graph has ~16k nodes rather than the few hundred a single street
  // would suggest. Stale entries are left in and skipped on pop.
  const heap = [[h(start), start]];
  const push = e => {
    heap.push(e);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  let guard = 200000;
  while (heap.length && guard-- > 0) {
    const cur = pop()[1];
    if (cur === goal) break;
    if (done[cur]) continue;                 // stale heap entry
    done[cur] = 1;
    for (const [nb, cost] of adj[cur]) {
      if (done[nb]) continue;
      const tentative = g[cur] + cost;
      if (tentative < g[nb]) {
        g[nb] = tentative;
        came[nb] = cur;
        push([tentative + h(nb), nb]);
      }
    }
  }
  if (g[goal] === Infinity || guard <= 0) return null;

  const path = [];
  for (let i = goal; i !== -1; i = came[i]) path.push([nodes[i * 2], nodes[i * 2 + 1]]);
  path.reverse();
  return { path, metres: g[goal] };
}

function walkTo(spot) {
  const r = route(you, spot);
  const crow = dist(spot);
  if (!r) {
    // No path in the graph. Say so and give the honest fallback rather than
    // drawing a line through buildings and calling it directions.
    city?.showRoute([[you.x, you.z], [spot.x, spot.z]], true);
    el.dRoute.hidden = false;
    el.dRoute.textContent =
      `No mapped footpath. ${fmtDist(crow)} in a straight line, heading ${bearing(spot)}.`;
    return;
  }
  const full = [[you.x, you.z], ...r.path, [spot.x, spot.z]];
  city?.showRoute(full, false);
  const mins = Math.max(1, Math.round(r.metres / 80));   // ~4.8 km/h
  el.dRoute.hidden = false;
  el.dRoute.textContent =
    `${fmtDist(r.metres)} on foot, about ${mins} min, heading ${bearing(spot)}.`;
}

// Compass bearing from you to the spot. x is east and z is south.
function bearing(spot) {
  const deg = (Math.atan2(spot.x - you.x, -(spot.z - you.z)) * 180 / Math.PI + 360) % 360;
  return ['north', 'north-east', 'east', 'south-east',
          'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8];
}

el.dNav.onclick = () => selected && walkTo(selected);

el.dPhoto.onclick = () => { if (selected) el.photoFile.click(); };
el.photoFile.onchange = async () => {
  const file = el.photoFile.files[0];
  el.photoFile.value = '';                      // so the same file can be re-picked
  if (file && selected) await addPhoto(selected, file);
};

// ---------------------------------------------------------------- position
function locate() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(p => {
    const [s, w, n, e] = DATA.bbox;
    const { latitude: lat, longitude: lng } = p.coords;
    if (lat < s || lat > n || lng < w || lng > e) return;   // outside the mapped area
    const [lat0, lng0] = DATA.centre;
    you = {
      x: (lng - lng0) * 111320 * Math.cos(lat0 * Math.PI / 180),
      z: -(lat - lat0) * 110574,
      real: true,
    };
    city?.setYou(you.x, you.z);
    $('origin').textContent = 'your GPS position';
    render();
  }, () => {}, { enableHighAccuracy: true, timeout: 8000 });
}

// ---------------------------------------------------------------- boot
async function boot() {
  identity();
  DATA = await (await fetch('data/jbr.json')).json();
  // Demo origin: the MEDIAN position of the eating and drinking places, which
  // lands you on The Walk among them. A mean would be dragged west by Ain Dubai
  // and Bluewaters and drop you in the channel, in open water.
  const mid = a => a.sort((x, y) => x - y)[a.length >> 1];
  const strip = DATA.spots.filter(s => ['food', 'cafe', 'bar'].includes(s.kind));
  you = { x: mid(strip.map(s => s.x)), z: mid(strip.map(s => s.z)), real: false };
  $('areaLabel').textContent = DATA.label;
  $('attrib').textContent = DATA.attribution;

  try {
    city = new City(el.canvas, DATA);
    city.repaint = () => city.updateMarkers(S.heat, new Set(Object.keys(S.saved)));
    city.onPick = (spot, ground) => {
      if (spot) {
        selected = spot;
        city.flyTo(spot);
        renderDetail(spot);
      } else if (ground && placing) {
        pendingAt = { x: ground.x, z: ground.z };
        el.hint.hidden = true;
        el.addForm.hidden = false;
        el.afName.focus();
      } else if (ground) {
        you = { x: ground.x, z: ground.z, real: false };
        city.setYou(you.x, you.z);
        city.showRoute(null);
        $('origin').textContent = 'a spot you picked';
        render();
      }
    };
    city.setSpots(allSpots());
    city.setYou(you.x, you.z);
    city.target.set(you.x, 0, you.z);
    const loop = () => { city.frame(); requestAnimationFrame(loop); };
    loop();
  } catch (err) {
    // No WebGL. The list below is the whole app and still works.
    console.warn('3D unavailable', err);
    el.shell.classList.add('no3d');
    el.fallback.hidden = false;
  }

  await loadPhotos();
  transport.start();
  render();
  renderFeed();
  locate();
  drain();

  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}

boot();
