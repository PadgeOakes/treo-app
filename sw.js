// Treo service worker - v3
// Pages (index.html, treo-beta.html, treo-test.html) load network-first, so updates always arrive when you are online,
// and fall back to the last saved copy when you are not (or the connection is very slow).
// The map library and fonts are saved the first time they load, so the map also works offline
// after one online visit. Address lookups and map tiles always go straight to the network.
const CACHE_NAME = 'treo-cache-v3';
const APP_SHELL = [
  './index.html',
  './treo-beta.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const SHELL_PATHS = APP_SHELL.map((p) => new URL(p, self.registration.scope).pathname);
const LIBRARY_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const SLOW_NETWORK_MS = 4000; // after this long with no answer, use the saved copy if there is one

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Network first; saved copy if the network fails or is too slow.
async function networkFirst(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const fromNetwork = fetch(request).then((res) => {
    // Save good, same-origin answers (not redirects - those can't be replayed for page loads).
    if (res && res.ok && res.type === 'basic' && !res.redirected) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  });
  try { event.waitUntil(fromNetwork.catch(() => {})); } catch (e) { /* refresh is best-effort */ }
  try {
    return await Promise.race([
      fromNetwork,
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), SLOW_NETWORK_MS))
    ]);
  } catch (err) {
    const saved = await cache.match(request, { ignoreSearch: true });
    if (saved) return saved;
    // Opened the bare folder address with no saved copy of it: use the saved main page.
    if (request.mode === 'navigate' && new URL(request.url).pathname.endsWith('/')) {
      const home = await cache.match(new URL('./index.html', self.registration.scope).href);
      if (home) return home;
    }
    return fromNetwork; // nothing saved: keep waiting for the network (or fail normally)
  }
}

// Manifest and icons: saved copy first (they only change when the cache name is bumped).
async function cacheFirst(request) {
  const saved = await caches.match(request, { ignoreSearch: true });
  return saved || fetch(request);
}

// Map library and fonts: saved copy first; fetched once and saved if not yet there.
async function libraryFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const saved = await cache.match(request.url);
  if (saved) return saved;
  // Ask with CORS so the saved copy is a normal, readable response (opaque ones waste storage quota).
  const res = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
  if (res && res.ok) cache.put(request.url, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin === self.location.origin) {
    const isPage = request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
    if (!isPage && SHELL_PATHS.includes(url.pathname)) {
      event.respondWith(cacheFirst(request));
    } else {
      event.respondWith(networkFirst(event));
    }
    return;
  }

  if (LIBRARY_HOSTS.includes(url.hostname)) {
    event.respondWith(libraryFirst(request));
  }
  // Anything else (address lookups, map tiles): not touched, goes straight to the network.
});
