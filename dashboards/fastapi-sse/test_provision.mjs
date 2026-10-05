// Tests for the provisioning app's logic (no phone, no browser):
//   schema.js against the shared vectors, rpc.js framing, deploy.js against a
//   simulated node, sync.js against a fake server with the real API's semantics.
// Run: node test_provision.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateScript } from "./static/schema.js";
import { Rpc } from "./static/rpc.js";
import { MemoryStore, addRecord, fleet } from "./static/store.js";
import { Sync } from "./static/sync.js";
import { deploy } from "./static/deploy.js";
import * as B from "./static/builder.js";
import { buildFleetView, derivedBleAddress, seenState } from "./static/fleetview.js";
import * as GW from "./static/gateway.js";
import { aligned, byBoard, colours, trim } from "./static/dashview.js";

const methods = JSON.parse(readFileSync(new URL("../../firmware/apps/hs_advertiser/methods.json", import.meta.url)));
const vectors = JSON.parse(readFileSync(new URL("./tests/script_vectors.json", import.meta.url)));
let passed = 0;
const ok = name => { passed++; console.log(`ok  ${name}`); };

// ---------- schema.js ----------
for (const c of vectors.cases) assert.deepEqual(validateScript(c.script, methods, c.shared), c.errors, c.name);
ok(`schema.js: ${vectors.cases.length} shared vectors`);

// ---------- simulated node ----------
/** A node that speaks the firmware's JSON-RPC rules over a framed characteristic. */
function simNode({ version = "v1.2.0", rpc = true, boardId = 1, failMethod = null, app = "hs_advertiser", family = true } = {}) {
  const dev = { app, family, version, boardId, settings: { led: { mode: "blink", blink_hz: 1 } }, reboots: 0 };
  const handle = (req) => {
    const r = (result) => ({ jsonrpc: "2.0", id: req.id, result });
    const e = (code, message, field) => ({ jsonrpc: "2.0", id: req.id, error: { code, message, ...(field ? { data: { field } } : {}) } });
    if (req.method === failMethod) return e(-32603, "simulated failure");
    switch (req.method) {
      case "device.info": return r({ device_id: "58e6c513033c", app: dev.app, version: dev.version, board_id: dev.boardId, ...(dev.family ? { family: "home_state-node" } : {}) });
      case "config.set":
        if (req.params?.led?.blink_hz > 10) return e(-32602, "must be between 0.1 and 10", "led.blink_hz");
        dev.settings = { ...dev.settings, ...req.params, led: { ...dev.settings.led, ...req.params?.led } };
        return r({ config: dev.settings, reboot_required: false });
      case "board.set_id": dev.boardId = req.params.id; return r({ board_id: dev.boardId });
      case "config.reset": dev.settings = { led: { mode: "blink", blink_hz: 1 } }; return r(dev.settings);
      case "device.reboot": dev.reboots++; return r({ rebooting: true });
      default: return e(-32601, `method not found: ${req.method}`);
    }
  };
  const makeRpc = (mtu) => {
    let listener; let inbox = [];
    const char = {
      addEventListener: (_, fn) => { listener = fn; },
      startNotifications: async () => {},
      async writeValueWithResponse(pkt) {
        if (pkt[0] & 2) inbox = [];
        inbox.push(...pkt.subarray(1));
        if (!(pkt[0] & 1)) return;
        const resp = new TextEncoder().encode(JSON.stringify(handle(JSON.parse(new TextDecoder().decode(new Uint8Array(inbox))))));
        const frag = mtu - 4;
        for (let off = 0; off < resp.length; off += frag) {
          const part = resp.subarray(off, off + frag);
          const n = new Uint8Array(part.length + 1);
          n[0] = (off === 0 ? 2 : 0) | (off + frag >= resp.length ? 1 : 0);
          n.set(part, 1);
          queueMicrotask(() => listener({ target: { value: { buffer: n.buffer } } }));
        }
      },
    };
    return new Rpc(char, mtu).start();
  };
  const node = {
    dev,
    rpc: null,
    async init(mtu = 517) { this.rpc = rpc ? await makeRpc(mtu) : null; return this; },
    async readInfo() { return { proj: dev.app, fw: dev.version, board: dev.boardId, state: "valid", rolled_back_from: null, mtu: 517 }; },
  };
  return node;
}

// ---------- rpc.js framing ----------
{
  const node = await simNode().init(23); // tiny MTU: requests and responses span many fragments
  const info = await node.rpc.call("device.info");
  assert.equal(info.device_id, "58e6c513033c");
  const set = await node.rpc.call("config.set", { led: { mode: "heartbeat", blink_hz: 2.5 } });
  assert.equal(set.config.led.blink_hz, 2.5);
  await assert.rejects(node.rpc.call("config.set", { led: { blink_hz: 99 } }), e => e.code === -32602 && /led.blink_hz/.test(e.message));
  await assert.rejects(node.rpc.call("no.such"), e => e.code === -32601);
  const [a, b] = await Promise.all([node.rpc.call("device.info"), node.rpc.call("config.set", { led: { blink_hz: 3 } })]);
  assert.ok(a.device_id && b.config.led.blink_hz === 3, "queued calls");
  ok("rpc.js: framing at MTU 23, errors, queued calls");
}

// ---------- deploy.js ----------
const profile = (version = "v1.2.0", calls = [{ method: "config.set", params: { led: { blink_hz: 4 } } }], app = "hs_advertiser") => ({
  id: crypto.randomUUID(), name: "fast-blink", app, version, config_id: null, config_name: "fast",
  script: { calls }, created_at: new Date().toISOString(),
});
const catalogue = { json: async () => methods, firmware: async () => new ArrayBuffer(8) };
function harness(node, opts = {}) {
  const store = new MemoryStore();
  const logs = [];
  const flashed = [];
  return {
    store, logs, flashed,
    run: (p, extra = {}) => deploy({
      node, profile: p, catalogue, store, log: m => logs.push(m),
      flashFn: async (n, img) => { flashed.push(`${p.app} ${p.version}`); n.dev.version = opts.flashTo ?? p.version; n.dev.app = opts.flashApp ?? p.app; n.dev.family = true; n.rpc = null; },
      reconnectFn: async (n) => { await n.init(); return n.readInfo(); },
      ...extra,
    }),
  };
}

{
  const node = await simNode({ version: "v1.2.0" }).init();
  const h = harness(node);
  const rec = await h.run(profile());
  assert.equal(rec.ok, true);
  assert.equal(rec.flashed, false);
  assert.equal(node.dev.settings.led.blink_hz, 4);
  assert.equal((await h.store.all("deployments")).length, 1);
  assert.equal((await h.store.outboxList()).length, 1);
  ok("deploy: same version -> config only, recorded + queued");
}
{
  const node = await simNode({ version: "v1.1.0", rpc: false }).init(); // pre-RPC node
  node.init = async function () { this.rpc = await (await simNode({ version: this.dev.version }).init()).rpc; return this; };
  const h = harness(node);
  const rec = await h.run(profile());
  assert.equal(rec.ok, true, rec.error);
  assert.equal(rec.flashed, true);
  assert.equal(rec.from_version, "v1.1.0");
  assert.equal(rec.device_id, "58e6c513033c");
  ok("deploy: pre-RPC v1.1.0 node -> flash, then RPC config, device ID recorded");
}
{
  const node = await simNode({ version: "v1.2.0" }).init();
  const h = harness(node);
  const rec = await h.run(profile("v1.2.0", [
    { method: "config.set", params: { led: { blink_hz: 2 } } }, { method: "device.reboot" }, { method: "config.set", params: { update_interval_ms: 10000 } },
  ]), { boardId: 7 });
  assert.equal(rec.ok, true, rec.error);
  assert.equal(node.dev.reboots, 1);
  assert.equal(node.dev.boardId, 7);
  assert.equal(rec.board_id, 7);
  assert.equal(rec.results.length, 4);
  assert.ok(h.logs.some(l => l.includes("device.reboot")));
  ok("deploy: board ID + reboot mid-script (reconnects) + later calls");
}
{
  const node = await simNode({ version: "v1.2.0", failMethod: "config.reset" }).init();
  const h = harness(node);
  const rec = await h.run(profile("v1.2.0", [{ method: "config.set", params: { led: { blink_hz: 2 } } }, { method: "config.reset" }, { method: "device.identify" }]));
  assert.equal(rec.ok, false);
  assert.match(rec.error, /call 2 \(config.reset\) failed/);
  assert.deepEqual(rec.results.map(r => r.ok), [true, false]); // stopped at the first error
  assert.equal((await h.store.all("deployments")).length, 1, "failures are recorded too");
  ok("deploy: failing call stops the script and is recorded");
}
{
  const node = await simNode({ version: "v1.2.0" }).init();
  const h = harness(node, { flashTo: "v1.2.0" }); // flash "succeeds" but node comes back on the old version
  const rec = await h.run(profile("v1.3.0"));
  assert.equal(rec.ok, false);
  assert.match(rec.error, /came back on hs_advertiser v1.2.0/);
  ok("deploy: node returning on the wrong version (rollback) is a failure");
}

{
  // a family node switches apps: flash, then the new app's config
  const node = await simNode({ version: "v1.3.1", app: "single-blink" }).init();
  const h = harness(node);
  const rec = await h.run(profile("v1.3.1", [{ method: "config.reset" }], "double-blink"));
  assert.equal(rec.ok, true, rec.error);
  assert.equal(rec.flashed, true);
  assert.deepEqual(h.flashed, ["double-blink v1.3.1"]);
  assert.equal(rec.from_app, "single-blink");
  assert.equal(node.dev.app, "double-blink");
  assert.ok(h.logs.some(l => l.includes("switching app: single-blink → double-blink")));
  ok("deploy: family node switches app (single-blink -> double-blink)");
}
{
  // an old node (no family) can't take another app: clear message, nothing flashed
  const node = await simNode({ version: "v1.3.0", app: "hs_advertiser", family: false }).init();
  const h = harness(node);
  const rec = await h.run(profile("v1.3.1", [{ method: "config.reset" }], "single-blink"));
  assert.equal(rec.ok, false);
  assert.match(rec.error, /can't switch apps: deploy an hs_advertiser v1\.3\.1\+ profile/);
  assert.deepEqual(h.flashed, []);
  ok("deploy: pre-family node refused for an app switch, told to use the bridge");
}
{
  // switch "succeeds" but the node comes back on the old app: failure
  const node = await simNode({ version: "v1.3.1", app: "single-blink" }).init();
  const h = harness(node, { flashApp: "single-blink" });
  const rec = await h.run(profile("v1.3.1", [{ method: "config.reset" }], "double-blink"));
  assert.equal(rec.ok, false);
  assert.match(rec.error, /came back on single-blink v1\.3\.1/);
  ok("deploy: node returning on the wrong app is a failure");
}

// ---------- sync.js against a fake server ----------
function fakeServer() {
  const tables = { configs: new Map(), profiles: new Map(), deployments: new Map(), archives: new Map() };
  let seq = 0;
  let down = false;
  const fetchFn = async (url, init = {}) => {
    if (down) throw new TypeError("Failed to fetch");
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      const accepted = {}, rejected = [];
      for (const [t, recs] of Object.entries(body)) {
        accepted[t] = [];
        for (const r of recs) {
          if (t === "configs" && validateScript(r.script, methods).length) { rejected.push({ table: t, id: r.id, errors: validateScript(r.script, methods) }); continue; }
          if (!tables[t].has(r.id)) tables[t].set(r.id, { ...r, seq: ++seq });
          accepted[t].push(r.id);
        }
      }
      return new Response(JSON.stringify({ accepted, rejected }));
    }
    const since = Number(new URL(url, "http://x/").searchParams.get("since"));
    const out = { seq: Math.max(seq, since) };
    for (const [t, m] of Object.entries(tables)) out[t] = [...m.values()].filter(r => r.seq > since);
    return new Response(JSON.stringify(out));
  };
  return { tables, fetchFn, setDown: v => { down = v; } };
}
{
  const server = fakeServer();
  const phone = new MemoryStore();
  const sync = new Sync(phone, { fetchFn: server.fetchFn });
  server.setDown(true); // offline on site: deploys still happen and queue up
  const node = await simNode().init();
  const h = harness(node);
  h.store = phone;
  await deploy({ node, profile: profile(), catalogue, store: phone, flashFn: async () => {}, reconnectFn: async n => n.readInfo() });
  assert.equal(await sync.run(), null);
  assert.equal(sync.state.online, false);
  assert.equal(sync.state.pending, 1);

  server.setDown(false); // back online
  const good = await addRecord(phone, "configs", { id: crypto.randomUUID(), app: "hs_advertiser", version: "v1.2.0", name: "ok", script: { calls: [{ method: "config.reset" }] }, created_at: new Date().toISOString() });
  const bad = await addRecord(phone, "configs", { id: crypto.randomUUID(), app: "hs_advertiser", version: "v1.2.0", name: "bad", script: { calls: [{ method: "board.set_id", params: { id: 2 } }] }, created_at: new Date().toISOString() });
  const res = await sync.run();
  assert.equal(res.accepted, 2);
  assert.equal(res.rejected.length, 1);
  assert.equal(sync.state.pending, 0);
  assert.equal(server.tables.deployments.size, 1);
  assert.ok((await phone.get("configs", bad.id))._rejected, "rejected record kept locally with its reason");
  assert.equal((await sync.run()).accepted, 0, "nothing left to push");

  const phone2 = new MemoryStore(); // a second phone pulls everything
  await new Sync(phone2, { fetchFn: server.fetchFn }).run();
  assert.equal((await phone2.all("deployments")).length, 1);
  assert.ok(await phone2.get("configs", good.id));
  const f = await fleet(phone2);
  assert.equal(f[0].device_id, "58e6c513033c");
  assert.equal(f[0].latest.profile_name, "fast-blink");
  ok("sync: offline queue, push on reconnect, rejection kept, second phone pulls fleet");
}

// ---------- builder.js ----------
{
  const callable = B.callableMethods(methods).map(m => m.name);
  assert.ok(callable.includes("config.set") && !callable.includes("board.set_id") && !callable.includes("device.info"));
  const def = JSON.parse(readFileSync(new URL("../../firmware/apps/hs_advertiser/default.json", import.meta.url)));
  let s = { calls: def.calls };
  // a fresh config.set call is filled from the schema defaults and equals the shipped default
  assert.deepEqual(B.newCall(methods, "config.set"), def.calls[0]);
  const fields = B.fieldsFor(methods.methods["config.set"].params, s.calls[0].params);
  const led = fields.find(f => f.key === "led");
  assert.equal(led.kind, "object");
  assert.deepEqual(led.children.map(f => [f.key, f.kind, f.value]), [["mode", "enum", "blink"], ["blink_hz", "range", 1]]);
  assert.equal(fields.find(f => f.key === "update_interval_ms").kind, "range");
  assert.equal(B.stepFor({ type: "number", minimum: 0.1, maximum: 10 }), 0.1);
  assert.equal(B.stepFor({ type: "integer", minimum: 1, maximum: 300 }), 1);

  s = B.setParam(s, 0, ["led", "blink_hz"], 4);
  s = B.unsetParam(s, 0, ["adv_interval_ms"]);
  assert.deepEqual(s.calls[0].params, { update_interval_ms: 5000, led: { mode: "blink", blink_hz: 4 } });
  s = B.unsetParam(B.unsetParam(s, 0, ["led", "mode"]), 0, ["led", "blink_hz"]);
  assert.ok(!("led" in s.calls[0].params), "empty parent object dropped");
  s = B.addCall(s, B.newCall(methods, "device.identify"));
  s = B.addCall(s, B.newCall(methods, "device.reboot"));
  assert.deepEqual(s.calls.map(c => c.method), ["config.set", "device.identify", "device.reboot"]);
  assert.deepEqual(s.calls[1].params, { seconds: 10 });
  assert.deepEqual(s.calls[2], { method: "device.reboot" });
  s = B.moveCall(s, 2, -1);
  assert.deepEqual(s.calls.map(c => c.method), ["config.set", "device.reboot", "device.identify"]);
  assert.equal(B.moveCall(s, 0, -1), s, "can't move past the top");
  s = B.removeCall(s, 1);
  assert.deepEqual(s.calls.map(c => c.method), ["config.set", "device.identify"]);
  assert.deepEqual(validateScript(s, methods), [], "builder output is a valid script");
  assert.ok(s.calls.every(c => B.representable(c, methods)));
  assert.equal(B.representable({ method: "config.set", params: { colour: "red" } }, methods), false);
  assert.equal(B.representable({ method: "led.party" }, methods), false);
  ok("builder.js: schema fields, defaults, set/unset, add/move/remove, valid output");
}

// ---------- fleetview.js ----------
{
  assert.equal(derivedBleAddress("58e6c513033c"), "58:E6:C5:13:03:3E");
  assert.equal(derivedBleAddress("58e6c5195088"), "58:E6:C5:19:50:8A");
  assert.equal(derivedBleAddress("0000000000ff"), "00:00:00:00:01:01");
  const t0 = Date.now();
  assert.equal(seenState(new Date(t0 - 5000).toISOString(), t0), "ok");
  assert.equal(seenState(new Date(t0 - 120000).toISOString(), t0), "stale");
  assert.equal(seenState(null, t0), "lost");

  const iso = s => new Date(t0 - s * 1000).toISOString();
  const pA = { id: "pa", name: "fast-blink", rf_stack: "v2", config_name: "fast" };
  const pB = { id: "pb", name: "beacon", rf_stack: "v1", config_name: "default" };
  const dep = (device, profile, ok, ago, extra = {}) => ({
    device_id: device, profile_id: profile.id, profile_name: profile.name, app: "hs_advertiser", version: "v1.3.0",
    ok, finished_at: iso(ago), board_id: 1, ...extra });
  const store = new MemoryStore();
  for (const d of [
    dep("58e6c513033c", pA, true, 300),                                   // hs-01: fast-blink (no ble_address: derived)
    dep("58e6c513033c", pB, false, 100),                                  // ...a later failed deploy doesn't move it
    dep("58e6c5195088", pB, true, 50, { board_id: 2, ble_address: "58:E6:C5:19:50:8A" }),
    dep("aaaaaaaaaaaa", pA, true, 60, { board_id: 3 }),
  ]) await store.put("deployments", { id: crypto.randomUUID(), ...d });
  const metrics = [
    { address: "58:E6:C5:13:03:3E", board_id: 1, last_seen: iso(3), rssi_last: -55, capture_pct: 99.5, missed: 2 },
    { address: "58:E6:C5:19:50:8A", board_id: 2, last_seen: iso(2), rssi_last: -50, capture_pct: 100, missed: 0 },
    { address: "11:22:33:44:55:66", board_id: 5, last_seen: iso(10), rssi_last: -70, capture_pct: 80, missed: 9 },
  ];
  const v = buildFleetView(await fleet(store), metrics, [pA, pB]);
  assert.deepEqual(v.groups.map(g => g.name), ["beacon", "fast-blink"], "groups sorted by profile name");
  const fast = v.groups.find(g => g.name === "fast-blink");
  assert.equal(fast.rf_stack, "v2");
  assert.deepEqual(fast.devices.map(d => d.board_id), [1, 3], "devices sorted by board ID");
  const hs01 = fast.devices[0];
  assert.equal(hs01.device_id, "58e6c513033c");
  assert.equal(hs01.latest.ok, false, "latest attempt shown...");
  assert.equal(hs01.current.profile_name, "fast-blink", "...but it stays in its last good profile");
  assert.equal(hs01.metrics.rssi_last, -55, "metrics joined via derived BLE address");
  assert.equal(v.groups[0].devices[0].metrics.capture_pct, 100, "metrics joined via recorded ble_address");
  assert.equal(fast.devices[1].metrics, null, "no readings for a device the scanner hasn't heard");
  assert.deepEqual(v.unprovisioned.map(m => m.address), ["11:22:33:44:55:66"]);
  ok("fleetview.js: grouping, last-good profile, metrics join, unprovisioned");
}

// ---------- gateway.js ----------
{
  // a node buffering readings: counter c at uptime u = 5c, paged by readings.read like the firmware
  const node = { ring: [], boot: 111, now: 0, board: 2 };
  const push = n => { for (let i = 0; i < n; i++) { const c = node.ring.length; node.ring.push({ c, u: c * 5, t: 30 + c / 10 }); node.now = c * 5 + 2; } };
  const rpc = { async call(m, p = {}) {
    if (m === "device.info") return { device_id: "58e6c5195088", ble_address: "58:E6:C5:19:50:8A", board_id: node.board, app: "single-blink", version: "v1.3.1" };
    if (m !== "readings.read") throw Object.assign(new Error("method not found"), { code: -32601 });
    const same = p.boot_id === undefined || p.boot_id === node.boot;
    const after = same && p.after_uptime_s !== undefined ? p.after_uptime_s : -1;
    const rest = node.ring.filter(r => r.u > after);
    return { boot_id: node.boot, same_boot: same, now_uptime_s: node.now, board_id: node.board, buffered: node.ring.length,
             more: rest.length > (p.limit ?? 50), readings: rest.slice(0, p.limit ?? 50) };
  } };
  const store = new MemoryStore();
  const T = Date.parse("2026-10-05T12:00:00Z");
  push(120);
  let r = await GW.collect({ rpc }, store, { now: () => T });
  assert.equal(r.collected, 120, "paged across 3 calls (50 + 50 + 20)");
  const rows = (await store.all("gateway")).sort((a, b) => a.counter - b.counter);
  assert.equal(rows[0].counter, 0, "includes the reading at uptime 0");
  // reading 119 was taken at uptime 595; node uptime now 597 -> 2 s before collection
  assert.equal(rows[119].received_at, new Date(T - 2000).toISOString());
  assert.equal(rows[0].received_at, new Date(T - 597000).toISOString());
  assert.equal(rows[0].address, "58:E6:C5:19:50:8A");
  assert.equal(rows[0].name, "hs-02");
  r = await GW.collect({ rpc }, store, { now: () => T + 1000 });
  assert.equal(r.collected, 0, "nothing new: cursor remembered");
  push(3);
  r = await GW.collect({ rpc }, store, { now: () => T + 20000 });
  assert.equal(r.collected, 3);
  assert.equal(await store.count("gateway"), 123);
  // node reboots: new boot id, counters restart -> everything it has is taken, ids don't collide
  node.ring = []; node.boot = 222; push(4);
  const logs = [];
  r = await GW.collect({ rpc }, store, { now: () => T + 60000, log: m => logs.push(m) });
  assert.equal(r.collected, 4);
  assert.ok(logs.some(l => l.includes("rebooted")));
  assert.equal(await store.count("gateway"), 127);
  // old firmware without the buffer
  const old = { rpc: { call: async m => (m === "device.info" ? { device_id: "x", ble_address: "AA:AA:AA:AA:AA:AA", board_id: 1, app: "hs_advertiser", version: "v1.3.0" } : (() => { throw Object.assign(new Error("nf"), { code: -32601 }); })()) } };
  await assert.rejects(GW.collect(old, new MemoryStore()), /needs firmware v1\.3\.1/);
  await assert.rejects(GW.collect({ rpc: null }, new MemoryStore()), /no JSON-RPC/);

  // upload: batches, rows removed only once the server has them
  const posts = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push(body.readings.length);
    return new Response(JSON.stringify({ inserted: body.readings.length - 1, duplicates: 1 }));
  };
  const up = await GW.upload(store, { fetchFn, batch: 50 });
  assert.deepEqual(posts, [50, 50, 27]);
  assert.deepEqual(up, { inserted: 124, duplicates: 3, uploaded: 127 });
  assert.equal(await store.count("gateway"), 0);
  // a failed upload keeps everything for next time
  await store.put("gateway", { ...rows[0] });
  await assert.rejects(GW.upload(store, { fetchFn: async () => new Response("no", { status: 503 }) }), /HTTP 503/);
  assert.equal(await store.count("gateway"), 1);
  ok("gateway.js: paged collect, uptime->time, cursor, reboot, old firmware, batched upload");
}

// ---------- dashview.js ----------
{
  const rows = [
    { board: "hs-02", received_at: "2026-10-05T10:00:05Z", temp_c: 31, rssi: -50 },
    { board: "hs-01", received_at: "2026-10-05T10:00:00Z", temp_c: 30, rssi: -60 },
    { board: "hs-01", received_at: "2026-10-05T10:00:10Z", temp_c: 30.5, rssi: -61 },
  ];
  const s = byBoard(rows);
  const d = aligned(s, ["hs-01", "hs-02"], "temp");
  assert.equal(d[0].length, 3);
  assert.deepEqual(d.slice(1), [[30, null, 30.5], [null, 31, null]], "one column per board on a shared axis");
  assert.deepEqual(colours(["hs-02", "hs-01"]), colours(["hs-01", "hs-02"]), "colour by name, not by order seen");
  trim(s, 0.1, Date.parse("2026-10-05T10:00:10Z") / 1000);
  assert.deepEqual([s["hs-01"].temp, s["hs-02"].temp], [[30.5], [31]]);
  ok("dashview.js: per-board aligned series, stable colours, range trim");
}

console.log(`\n${passed} test groups passed`);
