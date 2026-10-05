// Phone <-> server sync. Records are immutable with client-made UUIDs, so:
//   push: POST everything in the outbox (re-sending is harmless); drop accepted ones,
//         keep rejected ones out of the outbox but remember why.
//   pull: GET everything after our cursor and store it (dedupe by id).
// `fetchFn` is injectable for tests.

import { TABLES } from "./store.js";

export class Sync {
  constructor(store, { fetchFn = (...a) => fetch(...a), base = "" } = {}) {
    this.store = store;
    this.fetch = fetchFn;
    this.base = base;
    this.listeners = new Set();
    this.state = { online: null, pending: 0, lastSync: null, error: null, rejected: [] };
  }

  onChange(fn) { this.listeners.add(fn); fn(this.state); }
  #emit(patch) { Object.assign(this.state, patch); for (const fn of this.listeners) fn(this.state); }

  async refreshPending() {
    this.#emit({ pending: (await this.store.outboxList()).length });
  }

  async push() {
    const items = await this.store.outboxList();
    if (!items.length) return { accepted: 0, rejected: [] };
    const body = Object.fromEntries(TABLES.map(t => [t, []]));
    for (const { table, id } of items) {
      const rec = await this.store.get(table, id);
      if (rec) body[table].push(rec);
    }
    const r = await this.fetch(`${this.base}api/sync`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`push failed: HTTP ${r.status}`);
    const res = await r.json();
    let accepted = 0;
    for (const t of TABLES) {
      for (const id of res.accepted[t] ?? []) { await this.store.outboxRemove(t, id); accepted++; }
    }
    for (const rej of res.rejected ?? []) {
      // the server will never take it: stop retrying, but keep the record locally and say why
      await this.store.outboxRemove(rej.table, rej.id);
      const rec = await this.store.get(rej.table, rej.id);
      if (rec) await this.store.put(rej.table, { ...rec, _rejected: rej.errors });
    }
    return { accepted, rejected: res.rejected ?? [] };
  }

  async pull() {
    const since = (await this.store.getMeta("cursor")) ?? 0;
    const r = await this.fetch(`${this.base}api/sync?since=${since}`);
    if (!r.ok) throw new Error(`pull failed: HTTP ${r.status}`);
    const res = await r.json();
    let added = 0;
    for (const t of TABLES) {
      for (const rec of res[t] ?? []) {
        if (!(await this.store.get(t, rec.id))) added++;
        const { seq, ...clean } = rec;
        await this.store.put(t, clean);
      }
    }
    await this.store.setMeta("cursor", res.seq);
    return { added };
  }

  /** Push then pull. Never throws: failure just means offline (state.online = false). */
  async run() {
    try {
      const pushed = await this.push();
      const pulled = await this.pull();
      await this.store.setMeta("lastSync", new Date().toISOString());
      this.#emit({ online: true, error: null, lastSync: new Date().toISOString(),
                   rejected: [...this.state.rejected, ...pushed.rejected] });
      await this.refreshPending();
      return { ...pushed, ...pulled };
    } catch (e) {
      this.#emit({ online: false, error: e.message });
      await this.refreshPending();
      return null;
    }
  }
}
