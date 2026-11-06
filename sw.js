const CACHE_NAME = 'taser7-tactical-v1';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/ue_mannequin_retopology.glb',
  '/vendor/three/build/three.module.js',
  '/vendor/three/examples/jsm/loaders/GLTFLoader.js',
  '/vendor/three/examples/jsm/environments/RoomEnvironment.js',
  '/js/fsm.js',
  '/js/audio.js',
  '/js/ballistics.js',
  '/js/scene.js',
  '/js/xr.js',
  '/js/pwa.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[TASER 7 SW] Precaching tactical assets...');
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[TASER 7 SW] Non-fatal precache item failed:', err);
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

  // Stale-While-Revalidate or Cache-First for local assets
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch in background to update cache for non-binary assets
        if (!req.url.endsWith('.glb')) {
          fetch(req).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(req, networkResponse.clone()));
            }
          }).catch(() => {/* Offline fallback */});
        }
        return cachedResponse;
      }

      return fetch(req).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200) {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(req, responseToCache);
        });
        return networkResponse;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (req.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
