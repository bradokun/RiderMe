/* RiderMe service worker — build 279.
 *
 * Two jobs: make the app installable + work offline as a shell, and be ready to
 * receive Web Push once the backend is wired up (builds 280+). No precache
 * manifest — Vite hashes asset filenames, so runtime caching is safe and needs
 * no build integration:
 *   - navigations: network-first (always fresh online; the app updates often),
 *     falling back to the cached shell offline.
 *   - same-origin static assets (hashed JS/CSS/icons): cache-first.
 * Cross-origin requests (Supabase, analytics, fonts, map tiles) are never
 * touched — the app must always hit the network for those.
 */
const SHELL = 'riderme-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // leave Supabase/analytics/fonts/tiles alone

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // Cache the app shell under a stable key so a token-bearing URL (?code=…)
        // is never stored, and offline always gets a clean index.
        const cache = await caches.open(SHELL);
        cache.put('/', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') {
      const cache = await caches.open(SHELL);
      cache.put(req, res.clone());
    }
    return res;
  })());
});

/* PUSH — the payload the edge function will send is { title, body, url, tag }.
 * Handlers are here now so enabling push later is a backend-only change. */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  const title = data.title || 'RiderMe';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.navigate(url); } catch {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
