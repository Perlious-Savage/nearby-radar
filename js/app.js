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
const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];

const $ = id => document.getElementById(id);
const el = {};
for (const id of ['net', 'netName', 'who', 'crew', 'canvas', 'cards', 'feed', 'stale',
  'rNear', 'rOpen', 'rSaved', 'rQueue', 'shell', 'fallback', 'detail', 'dName',
  'dMeta', 'dNote', 'dDist', 'dClose', 'dSave', 'dPin', 'sheet']) el[id] = $(id);

// ---------------------------------------------------------------- state
const blank = { handle: '', crew: '', saved: {}, heat: {}, outbox: [], seen: [] };
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
let filter = 'all';
let selected = null;
let feedItems = [];

// ---------------------------------------------------------------- identity
const rand = n => Math.random().toString(36).slice(2, 2 + n).toUpperCase();

function identity() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('crew')) S.crew = hash.get('crew').toUpperCase().slice(0, 6);
  if (!S.crew) S.crew = rand(4);
  if (!S.handle) S.handle = 'guest' + Math.floor(Math.random() * 900 + 100);
  save();
  el.who.textContent = S.handle;
  el.crew.textContent = S.crew;
}

el.who.onclick = () => {
  const v = prompt('Handle. No password, no email, it just keys your saved list.', S.handle);
  if (v?.trim()) { S.handle = v.trim().slice(0, 16).toLowerCase(); save(); el.who.textContent = S.handle; }
};

el.crew.onclick = () => {
  const v = prompt('Crew code. Anyone who types the same code shares your live feed.', S.crew);
  if (v?.trim()) {
    S.crew = v.trim().toUpperCase().slice(0, 6);
    save();
    el.crew.textContent = S.crew;
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

  topic() { return `nearby/crew/${S.crew}`; },

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
      c.subscribe(this.topic());
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
    if (this.client && navigator.onLine) {
      this.client.publish(this.topic(), JSON.stringify(msg));
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
    this.onPin(msg, via);
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

transport.onPin = (msg) => {
  const spot = DATA.spots.find(s => s.id === msg.spot);
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
  return DATA.spots
    .filter(s => {
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
      <header>
        <h3>${esc(s.name)}</h3>
        <span class="dist">${fmtDist(dist(s))}</span>
      </header>
      <p class="meta"><span class="kind k-${s.kind}">${s.kind}</span>${status}</p>
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
  const near = DATA.spots.filter(s => dist(s) < 1000).length;
  const open = DATA.spots.filter(s => openState(s.hours)?.open).length;
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
  el.dSave.textContent = S.saved[s.id] ? 'Saved' : 'Save';
  el.dSave.classList.toggle('on', !!S.saved[s.id]);
  el.sheet.hidden = false;
}

// ---------------------------------------------------------------- events
el.cards.addEventListener('click', e => {
  const art = e.target.closest('[data-spot]');
  if (!art) return;
  const spot = DATA.spots.find(s => s.id === art.dataset.spot);
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'save') return toggleSave(spot);
  if (act === 'pin') return pin(spot);
  selected = spot;
  city?.flyTo(spot);
  renderDetail(spot);
});

el.dSave.onclick = () => selected && toggleSave(selected);
el.dPin.onclick = () => selected && pin(selected);
$('dClose2').onclick = () => { el.sheet.hidden = true; selected = null; city?.pullBack(); };

document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
  filter = b.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(o => o.setAttribute('aria-pressed', String(o === b)));
  render();
});

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
      } else if (ground) {
        you = { x: ground.x, z: ground.z, real: false };
        city.setYou(you.x, you.z);
        $('origin').textContent = 'a spot you picked';
        render();
      }
    };
    city.setYou(0, 0);
    const loop = () => { city.frame(); requestAnimationFrame(loop); };
    loop();
  } catch (err) {
    // No WebGL. The list below is the whole app and still works.
    console.warn('3D unavailable', err);
    el.shell.classList.add('no3d');
    el.fallback.hidden = false;
  }

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
