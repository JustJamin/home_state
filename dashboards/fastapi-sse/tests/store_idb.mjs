// IndexedDB schema upgrades and self-healing (store.js), with fake-indexeddb.
// v1.3.1 regression: a phone ran a stale store.js next to new code, and the "gateway"
// object store was missing ("One of the specified object stores was not found").
//   node tests/store_idb.mjs
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IdbStore } from "../static/store.js";

const OLD_V1 = ["configs", "profiles", "deployments", "archives", "outbox", "meta"];
const raw = (name, version, upgrade) => new Promise((res, rej) => {
  const r = indexedDB.open(name, version);
  r.onupgradeneeded = () => upgrade?.(r.result);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const v1Schema = db => {
  for (const t of ["configs", "profiles", "deployments", "archives"]) db.createObjectStore(t, { keyPath: "id" });
  db.createObjectStore("outbox", { keyPath: ["table", "id"] });
  db.createObjectStore("meta");
};
let passed = 0;
const ok = m => { passed++; console.log(`ok  ${m}`); };

{ // A: database made by v1.2/1.3.0 code (version 1): upgrades, keeps data
  const old = await raw("A", 1, v1Schema);
  await new Promise((res, rej) => { const t = old.transaction("configs", "readwrite"); t.objectStore("configs").put({ id: "c1" }); t.oncomplete = res; t.onerror = rej; });
  old.close();
  const s = await IdbStore.open("A");
  assert.equal(s.db.version, 2);
  assert.ok(s.db.objectStoreNames.contains("gateway"));
  assert.deepEqual((await s.all("configs")).map(c => c.id), ["c1"], "existing records survive the upgrade");
  await s.put("gateway", { id: "g1" });
  assert.equal(await s.count("gateway"), 1);
  s.db.close();
  ok("v1 database upgrades to v2 with the gateway store, data kept");
}

{ // B: the phone's case: version 2 but no gateway store -> self-heal to version 3
  (await raw("B", 2, v1Schema)).close();
  const s = await IdbStore.open("B");
  assert.equal(s.db.version, 3);
  assert.ok(s.db.objectStoreNames.contains("gateway"));
  assert.equal(await s.count("gateway"), 0, "gateway store usable");
  s.db.close();
  // C: next launch: the database (3) is newer than the code's version (2) -> opens as is
  const again = await IdbStore.open("B");
  assert.equal(again.db.version, 3);
  assert.ok(OLD_V1.concat("gateway").every(n => again.db.objectStoreNames.contains(n)));
  again.db.close();
  ok("missing store self-heals (v2 -> v3); later opens cope with the newer version");
}

{ // D: an old tab holding the database open doesn't block the upgrade forever
  const oldTab = await raw("D", 1, v1Schema);
  oldTab.onversionchange = () => oldTab.close(); // what store.js now does in every tab
  const s = await IdbStore.open("D");
  assert.ok(s.db.objectStoreNames.contains("gateway"));
  s.db.close();
  ok("an open older tab steps aside for the upgrade");
}

console.log(`\n${passed} IndexedDB checks passed`);
