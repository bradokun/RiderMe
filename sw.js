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
const SHELL = 'riderme-shell-v2';

/* PRECACHE ON INSTALL — build 610.
 *
 * The header above used to say "No precache manifest — Vite hashes asset filenames, so runtime
 * caching is safe and needs no build integration." Runtime caching IS safe. It is not sufficient,
 * and the gap was measured rather than argued — real build, real worker, browser HTTP cache
 * disabled so nothing could cheat:
 *
 *     after 1st visit:  {}                               <- nothing cached at all
 *     after 2nd visit:  ["/", index-*.css, index-*.js]   <- three entries
 *
 * TWO HOLES. The first visit caches NOTHING, because the navigation that loads the page happens
 * before this worker controls it — so install the app, lose signal, get nothing. And only what has
 * been fetched is ever there: MapView and QrCode are React.lazy dynamic imports, so the map and the
 * QR code were dead offline until you had opened each of them online at least once.
 *
 * A dynamic import cannot be found by parsing index.html — it is referenced from inside the main
 * bundle — so the list has to come from the build. vite.config.js writes /precache.json.
 *
 * ONE REQUEST AT A TIME, NOT cache.addAll. addAll is atomic: one 404 and the whole install fails,
 * which would leave a worker that never activates and an app with no offline story at all. Each
 * entry is allowed to fail on its own and the rest still land.
 *
 * AND A FAILED PRECACHE MUST NOT FAIL THE INSTALL. If the manifest itself cannot be fetched — the
 * very first load is offline, or the deploy is mid-flight — this resolves anyway and the old
 * runtime caching still works. An install that rejects leaves the previous worker in charge, which
 * on a first visit means no worker at all.
 *
 * `cache: 'no-store'` on the manifest: a stale manifest would precache the PREVIOUS deploy's
 * hashed filenames, which are exactly the files that no longer exist.
 */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try {
      const res = await fetch('/precache.json', { cache: 'no-store' });
      if (res && res.ok) {
        const { shell } = await res.json();
        const cache = await caches.open(SHELL);
        await Promise.all((shell || []).map(async (url) => {
          try {
            // HASHED ASSETS COME FROM THE HTTP CACHE; EVERYTHING ELSE IS REFETCHED.
            //
            // The first version passed `cache: 'no-store'` to every entry, which made install
            // download the whole app a SECOND time — the browser had just fetched the main bundle
            // to render the page, and this threw that away and asked for it again. On a phone on
            // mobile data that is the worst possible moment to double the payload.
            //
            // Under /assets/ the filename carries a content hash, so a cached copy cannot be the
            // wrong one — the default policy is safe and free. `/` and the manifest are NOT hashed,
            // so a stale copy is possible and those are still refetched.
            const hashed = url.startsWith('/assets/');
            const r = await fetch(url, hashed ? undefined : { cache: 'reload' });
            if (r && r.ok) await cache.put(url, r);
          } catch { /* one asset missing must not cost the others */ }
        }));
      }
    } catch { /* offline on first load — runtime caching still fills in later */ }
    await self.skipWaiting();
  })());
});
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

/* A NOTIFICATION MAY ONLY OPEN THIS APP — build 414.
 *
 * `url` arrives in the push payload and went straight into c.navigate() and
 * clients.openWindow(). Nothing checked where it pointed, so a payload carrying
 * an absolute off-origin URL would open that site from a tap on a RiderMe
 * notification — the app's own branding as the pretext, which is most of what
 * makes a phishing link work.
 *
 * NOT REACHABLE WHEN THIS WAS WRITTEN: both senders (push-on-notification and
 * send-reminders) hardcode url: "/". It is fixed anyway because the comment on
 * the push handler above advertises `{ title, body, url, tag }` as the contract,
 * so the first sender to put a deep link there inherits the gap — and it will be
 * written by someone adding a feature, not by someone auditing this file.
 *
 * RESOLVED, NOT PATTERN-MATCHED. `new URL(raw, origin)` resolves relatives
 * against this origin, so "/?join=CODE" keeps working and future deep links need
 * no further change here; only the resolved ORIGIN is compared. A string test
 * (startsWith("/"), or a regex) is the version that gets bypassed: "//evil.example"
 * starts with a slash and is protocol-relative, and "/\evil.example" is treated
 * as a host by some parsers. Resolving first removes the whole class.
 *
 * Anything that fails to parse, or resolves elsewhere, falls back to "/" — the
 * app still opens, which is what a person tapping a notification asked for. */
function sameOriginPath(raw) {
  try {
    const u = new URL(String(raw == null ? '/' : raw), self.location.origin);
    return u.origin === self.location.origin ? u.href : '/';
  } catch { return '/'; }
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = sameOriginPath(e.notification.data && e.notification.data.url);
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.navigate(url); } catch {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
