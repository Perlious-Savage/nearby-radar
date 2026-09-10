// Precache everything. The app has no network data source at all, so "works
// with no signal" reduces to: serve the whole bundle from cache, always.
const CACHE = 'nearby-v21';
const SHELL = [
  './', './index.html', './css/app.css',
  './js/app.js', './js/city.js', './js/hours.js',
  './data/jbr.json',
  './vendor/three.module.min.js', './vendor/mqtt.min.js',
  './fonts/geist.woff2', './fonts/geist-mono.woff2',
  './manifest.webmanifest',
  './photos/food1.jpg', './photos/food2.jpg', './photos/food3.jpg',
  './photos/food4.jpg', './photos/food5.jpg',
  './photos/cafe1.jpg', './photos/cafe2.jpg', './photos/cafe3.jpg',
  './photos/bar1.jpg', './photos/bar2.jpg',
  './photos/event1.jpg', './photos/event2.jpg',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache first: a hit is a complete, working app. Never intercept the MQTT
// WebSocket; only same-origin GETs belong to us.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
