// Service worker for the provisioning app: makes it start and run with no network.
//   app shell (page, JS, icons): network-first with a short timeout, falling back to the
//     cached copy, so updates arrive when online and the app still opens offline
//   catalogue files (/api/apps/<app>/<version>/<file>): cache-first, they're immutable
//     (catalogue.js fills the same cache when it keeps a version offline)
//   other /api/*: straight to the network; the app handles being offline itself
//   push: temperature alerts from the server; tapping one opens the dashboard (/) in the app
const SHELL = "hs-shell-v4";
const CATALOGUE = "hs-catalogue";
const SHELL_FILES = [
  "/provision", "/manifest.webmanifest", "/static/theme.css",
  "/static/app.js", "/static/ota.js", "/static/rpc.js", "/static/schema.js", "/static/store.js",
  "/static/sync.js", "/static/catalogue.js", "/static/deploy.js", "/static/builder.js", "/static/fleetview.js",
  "/static/gateway.js", "/", "/static/dashboard.js", "/static/dashview.js",
  "/static/vendor/uPlot.iife.min.js", "/static/vendor/uPlot.min.css",
  "/static/icons/icon-192.png", "/static/icons/icon-512.png",
];
const NETWORK_TIMEOUT_MS = 3000; // offline with the VPN half-up, fetches can hang rather than fail

self.addEventListener("install", e => {
  // cache: "reload" so the shell is never filled from a stale HTTP cache entry
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("hs-shell-") && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("network timeout")), ms));
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    // no-cache: always revalidate with the server (304 if unchanged), never trust a heuristic HTTP cache entry
    const res = await Promise.race([fetch(req, { cache: "no-cache" }), timeout(NETWORK_TIMEOUT_MS)]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw new Error("offline and not cached");
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CATALOGUE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (/^\/api\/apps\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)) return e.respondWith(cacheFirst(e.request));
  if (url.pathname.startsWith("/api/")) return; // network only
  if (SHELL_FILES.includes(url.pathname) || url.pathname.startsWith("/static/")) {
    return e.respondWith(networkFirst(e.request));
  }
});

// ---------- push alerts ----------

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data?.json() ?? {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title ?? "home_state", {
    body: d.body ?? "", tag: d.tag, renotify: Boolean(d.tag),
    icon: "/static/icons/icon-192.png", badge: "/static/icons/icon-192.png",
    data: { url: d.url ?? "/" },
  }));
});

// open the dashboard in the installed app: reuse an open app window if there is one
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url ?? "/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        if (new URL(w.url).pathname !== new URL(url).pathname && "navigate" in w) await w.navigate(url);
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
