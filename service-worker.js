const CACHE_NAME = 'taser7-tactical-v12';

// Relativa resurser för full kompatibilitet med GitHub Pages undermappar
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './sw.js',
  './service-worker.js',
  './ue_mannequin_retopology.glb',
  './js/app.js',
  './js/fsm.js',
  './js/audio.js',
  './js/ballistics.js',
  './js/scene.js',
  './js/xr.js',
  './js/pwa.js',
  './js/voice.js',
  './js/pose.js',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
  './icons/icon-maskable-512x512.png',
  './icons/apple-touch-icon.png',
  './icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[TASER 7 SW] Cachar app-skal och taktiska resurser...');
      await Promise.allSettled(
        PRECACHE_ASSETS.map((asset) =>
          cache.add(asset).catch((err) => {
            console.warn(`[TASER 7 SW] Kunde inte förhandscacha ${asset}:`, err.message);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => {
          console.log('[TASER 7 SW] Rensar gammal cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Chrome PWA-krav: fetch-lyssnare som hanterar nätverksanrop
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // 1. För sidnavigering (HTML): Network-first med offline-fallback till index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match('./index.html').then((cached) => cached || caches.match('./'));
        })
    );
    return;
  }

  // 2. För statiska filer (JS, 3D-modell, ikoner, audio): Cache-first med nätverksfallback
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        fetch(req)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(req, networkResponse));
            }
          })
          .catch(() => {/* Tyst offline */});
        return cachedResponse;
      }

      return fetch(req)
        .then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200) {
            return networkResponse;
          }
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return networkResponse;
        })
        .catch((err) => {
          console.warn('[TASER 7 SW] Nätverksfel vid hämtning av:', req.url, err);
        });
    })
  );
});
