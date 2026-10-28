// Court Cam service worker: app shell precache + runtime cache for the (big) AI model/wasm files.
const V = 'court-cam-v3';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'balltrack.js', 'manifest.webmanifest', 'fonts/fonts.css', 'vendor/vision_bundle.mjs', 'icon-180.png', 'icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url); if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const heavy = /\/(models|vendor|fonts)\//.test(u.pathname);
  if (heavy) { // cache-first for big immutable assets
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => { if (res.ok) { const cl = res.clone(); caches.open(V).then((c) => c.put(e.request, cl)); } return res; })));
  } else { // network-first for the app shell so updates land quickly
    e.respondWith(fetch(e.request).then((res) => { if (res.ok) { const cl = res.clone(); caches.open(V).then((c) => c.put(e.request, cl)); } return res; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
