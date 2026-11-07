const CACHE_NAME = 'taser7-tactical-v10';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
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
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[TASER 7 SW v4] Förhandscachar taktiska resurser...');
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[TASER 7 SW] Icke-kritisk resurs:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // För applikationskod och navigation: Network-First (alltid färsk kod online, fallback till cache offline)
  if (req.mode === 'navigate' || req.url.includes('/js/') || req.url.endsWith('index.html')) {
    event.respondWith(
      fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkResponse;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // För tunga statiska 3D-modeller, ikoner och vendor-bibliotek: Cache-First med nätverksfallback
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(req).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200) {
          return networkResponse;
        }
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return networkResponse;
      });
    })
  );
});
