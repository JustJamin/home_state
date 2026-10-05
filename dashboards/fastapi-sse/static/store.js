// Local data for the provisioning app: configs, profiles, deployments, archives
// (the same records as the server), an outbox of records not yet pushed, and
// small metadata (sync cursor, cached catalogue). IndexedDB on the phone;
// MemoryStore has the same interface for tests.

export const TABLES = ["configs", "profiles", "deployments", "archives"];

const tx = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export class IdbStore {
  static async open(name = "home_state") {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const t of TABLES) db.createObjectStore(t, { keyPath: "id" });
      db.createObjectStore("outbox", { keyPath: ["table", "id"] });
      db.createObjectStore("meta");
    };
    const s = new IdbStore();
    s.db = await tx(req);
    return s;
  }
  #os(name, mode = "readonly") { return this.db.transaction(name, mode).objectStore(name); }
  put(table, rec) { return tx(this.#os(table, "readwrite").put(rec)); }
  get(table, id) { return tx(this.#os(table).get(id)); }
  all(table) { return tx(this.#os(table).getAll()); }
  outboxAdd(table, id) { return tx(this.#os("outbox", "readwrite").put({ table, id })); }
  outboxList() { return tx(this.#os("outbox").getAll()); }
  outboxRemove(table, id) { return tx(this.#os("outbox", "readwrite").delete([table, id])); }
  getMeta(key) { return tx(this.#os("meta").get(key)); }
  setMeta(key, value) { return tx(this.#os("meta", "readwrite").put(value, key)); }
}

export class MemoryStore {
  constructor() {
    this.t = Object.fromEntries(TABLES.map(n => [n, new Map()]));
    this.outbox = new Map();
    this.meta = new Map();
  }
  async put(table, rec) { this.t[table].set(rec.id, structuredClone(rec)); }
  async get(table, id) { return structuredClone(this.t[table].get(id)); }
  async all(table) { return [...this.t[table].values()].map(r => structuredClone(r)); }
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
