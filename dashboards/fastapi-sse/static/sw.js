// Service worker for the provisioning app: makes it start and run with no network.
//   app shell (page, JS, icons): network-first with a short timeout, falling back to the
//     cached copy, so updates arrive when online and the app still opens offline
//   catalogue files (/api/apps/<app>/<version>/<file>): cache-first, they're immutable
//     (catalogue.js fills the same cache when it keeps a version offline)
//   other /api/*: straight to the network; the app handles being offline itself
const SHELL = "hs-shell-v1";
const CATALOGUE = "hs-catalogue";
const SHELL_FILES = [
  "/provision", "/manifest.webmanifest",
  "/static/app.js", "/static/ota.js", "/static/rpc.js", "/static/schema.js", "/static/store.js",
  "/static/sync.js", "/static/catalogue.js", "/static/deploy.js",
  "/static/icons/icon-192.png", "/static/icons/icon-512.png",
];
const NETWORK_TIMEOUT_MS = 3000; // offline with the VPN half-up, fetches can hang rather than fail

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
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
    const res = await Promise.race([fetch(req), timeout(NETWORK_TIMEOUT_MS)]);
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
