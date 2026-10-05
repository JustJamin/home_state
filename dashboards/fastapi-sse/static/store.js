// Local data for the provisioning app: configs, profiles, deployments, archives
// (the same records as the server), an outbox of records not yet pushed, readings
// collected by the phone gateway (until uploaded), and small metadata (sync cursor,
// cached catalogue, gateway cursors). IndexedDB on the phone;
// MemoryStore has the same interface for tests.

export const TABLES = ["configs", "profiles", "deployments", "archives"];

const tx = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// every object store this code expects, with how to create it
const STORES = {
  ...Object.fromEntries(TABLES.map(t => [t, { keyPath: "id" }])),
  outbox: { keyPath: ["table", "id"] },
  meta: undefined,               // out-of-line keys
  gateway: { keyPath: "id" },    // v1.3.1
};
const DB_VERSION = 2;

export class IdbStore {
  /** Open the database, creating any missing object stores. Self-healing: if the database is
   *  already at (or past) our version but a store is missing (e.g. an older copy of this file
   *  opened it), reopen one version higher to add it. */
  static async open(name = "home_state") {
    let db = await IdbStore.#openAt(name, DB_VERSION);
    const missing = Object.keys(STORES).filter(s => !db.objectStoreNames.contains(s));
    if (missing.length) {
      const v = db.version + 1;
      db.close();
      db = await IdbStore.#openAt(name, v);
    }
    // another tab opening a newer version: step aside instead of blocking its upgrade
    db.onversionchange = () => db.close();
    const s = new IdbStore();
    s.db = db;
    return s;
  }

  static #openAt(name, version) {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(name, version); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const [store, opts] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, opts);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        // VersionError: the database is already newer than `version` (an earlier self-heal): open it as it is
        if (req.error?.name === "VersionError") resolve(IdbStore.#openAt(name, undefined));
        else reject(req.error);
      };
      req.onblocked = () => console.warn("IndexedDB upgrade waiting for another tab to close");
    });
  }
  #os(name, mode = "readonly") { return this.db.transaction(name, mode).objectStore(name); }
  put(table, rec) { return tx(this.#os(table, "readwrite").put(rec)); }
  get(table, id) { return tx(this.#os(table).get(id)); }
  all(table) { return tx(this.#os(table).getAll()); }
  delete(table, id) { return tx(this.#os(table, "readwrite").delete(id)); }
  count(table) { return tx(this.#os(table).count()); }
  outboxAdd(table, id) { return tx(this.#os("outbox", "readwrite").put({ table, id })); }
  outboxList() { return tx(this.#os("outbox").getAll()); }
  outboxRemove(table, id) { return tx(this.#os("outbox", "readwrite").delete([table, id])); }
  getMeta(key) { return tx(this.#os("meta").get(key)); }
  setMeta(key, value) { return tx(this.#os("meta", "readwrite").put(value, key)); }
}

export class MemoryStore {
  constructor() {
    this.t = Object.fromEntries([...TABLES, "gateway"].map(n => [n, new Map()]));
    this.outbox = new Map();
    this.meta = new Map();
  }
  async put(table, rec) { this.t[table].set(rec.id, structuredClone(rec)); }
  async get(table, id) { return structuredClone(this.t[table].get(id)); }
  async all(table) { return [...this.t[table].values()].map(r => structuredClone(r)); }
  async delete(table, id) { this.t[table].delete(id); }
  async count(table) { return this.t[table].size; }
  async outboxAdd(table, id) { this.outbox.set(`${table}/${id}`, { table, id }); }
  async outboxList() { return [...this.outbox.values()]; }
  async outboxRemove(table, id) { this.outbox.delete(`${table}/${id}`); }
  async getMeta(key) { return this.meta.get(key); }
  async setMeta(key, value) { this.meta.set(key, value); }
}

/** Create a record locally and queue it for the server. Records are never changed afterwards. */
export async function addRecord(store, table, rec) {
  await store.put(table, rec);
  await store.outboxAdd(table, rec.id);
  return rec;
}

/** Archived record ids for a kind ("config" | "profile"). */
export async function archivedIds(store, kind) {
  return new Set((await store.all("archives")).filter(a => a.kind === kind).map(a => a.record_id));
}

/** Fleet view: latest deployment per device_id, plus its history (newest first). */
export async function fleet(store) {
  const byDevice = new Map();
  for (const d of await store.all("deployments")) {
    if (!byDevice.has(d.device_id)) byDevice.set(d.device_id, []);
    byDevice.get(d.device_id).push(d);
  }
  return [...byDevice.entries()].map(([device_id, list]) => {
    list.sort((a, b) => b.finished_at.localeCompare(a.finished_at));
    return { device_id, latest: list[0], lastGood: list.find(d => d.ok) ?? null, history: list };
  }).sort((a, b) => b.latest.finished_at.localeCompare(a.latest.finished_at));
}
