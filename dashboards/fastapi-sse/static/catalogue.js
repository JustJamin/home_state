// Firmware catalogue with offline copies.
//   - the list of apps/versions comes from /api/apps and is remembered in the store,
//   - a version's files (firmware.bin, default.config.json, methods.json) are kept in
//     Cache Storage ("hs-catalogue"); they're immutable, so cache-first is always right.
// Offline policy: every version used by a saved profile + the newest of each app,
// plus versions the user marks "keep offline".

const CACHE = "hs-catalogue";
const FILES = ["firmware.bin", "default.config.json", "methods.json"];
const url = (app, version, file) => `api/apps/${encodeURIComponent(app)}/${encodeURIComponent(version)}/${file}`;

export class Catalogue {
  constructor(store, { fetchFn = (...a) => fetch(...a), caches: cacheStorage = globalThis.caches } = {}) {
    this.store = store;
    this.fetch = fetchFn;
    this.caches = cacheStorage;
  }

  /** [{app, versions: [...]}]: from the server when reachable, else the last copy. */
  async apps() {
    try {
      const r = await this.fetch("api/apps");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const apps = await r.json();
      await this.store.setMeta("apps", apps);
      return apps;
    } catch {
      return (await this.store.getMeta("apps")) ?? [];
    }
  }

  async #response(app, version, file) {
    const cache = await this.caches.open(CACHE);
    const key = url(app, version, file);
    let r = await cache.match(key);
    if (!r) {
      r = await this.fetch(key);
      if (!r.ok) throw new Error(`${app} ${version}: ${file} unavailable (HTTP ${r.status})`);
      await cache.put(key, r.clone());
    }
    return r;
  }

  async json(app, version, file) { return (await this.#response(app, version, file)).json(); }
  async firmware(app, version) { return (await this.#response(app, version, "firmware.bin")).arrayBuffer(); }

  async isOffline(app, version) {
    const cache = await this.caches.open(CACHE);
    for (const f of FILES) if (!(await cache.match(url(app, version, f)))) return false;
    return true;
  }

  async keepOffline(app, version) {
    for (const f of FILES) await this.#response(app, version, f);
  }

  /** Download what the offline policy needs. Returns [{app, version, ok, error?}]. */
  async ensureOffline(apps) {
    const want = new Map();
    const add = (app, version) => want.set(`${app}\n${version}`, { app, version });
    for (const a of apps) {
      const newest = a.versions.find(v => v.configurable);
      if (newest) add(a.app, newest.version);
    }
    for (const p of await this.store.all("profiles")) add(p.app, p.version);
    for (const k of (await this.store.getMeta("keepOffline")) ?? []) { const [a, v] = k.split("\n"); add(a, v); }
    const out = [];
    for (const { app, version } of want.values()) {
      try { await this.keepOffline(app, version); out.push({ app, version, ok: true }); }
      catch (e) { out.push({ app, version, ok: false, error: e.message }); }
    }
    return out;
  }
}
