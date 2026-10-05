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

const methods = JSON.parse(readFileSync(new URL("../../firmware/config/methods.json", import.meta.url)));
const vectors = JSON.parse(readFileSync(new URL("./tests/script_vectors.json", import.meta.url)));
let passed = 0;
const ok = name => { passed++; console.log(`ok  ${name}`); };

// ---------- schema.js ----------
for (const c of vectors.cases) assert.deepEqual(validateScript(c.script, methods, c.shared), c.errors, c.name);
ok(`schema.js: ${vectors.cases.length} shared vectors`);

// ---------- simulated node ----------
/** A node that speaks the firmware's JSON-RPC rules over a framed characteristic. */
function simNode({ version = "v1.2.0", rpc = true, boardId = 1, failMethod = null } = {}) {
  const dev = { version, boardId, settings: { led: { mode: "blink", blink_hz: 1 } }, reboots: 0 };
  const handle = (req) => {
    const r = (result) => ({ jsonrpc: "2.0", id: req.id, result });
    const e = (code, message, field) => ({ jsonrpc: "2.0", id: req.id, error: { code, message, ...(field ? { data: { field } } : {}) } });
    if (req.method === failMethod) return e(-32603, "simulated failure");
    switch (req.method) {
      case "device.info": return r({ device_id: "58e6c513033c", app: "hs_advertiser", version: dev.version, board_id: dev.boardId });
      case "config.set":
        if (req.params?.led?.blink_hz > 10) return e(-32602, "must be between 0.1 and 10", "led.blink_hz");
        dev.settings = { ...dev.settings, ...req.params, led: { ...dev.settings.led, ...req.params?.led } };
        return r({ config: dev.settings, reboot_required: false });
      case "board.set_id": dev.boardId = req.params.id; return r({ board_id: dev.boardId });
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
    async readInfo() { return { proj: "hs_advertiser", fw: dev.version, board: dev.boardId, state: "valid", rolled_back_from: null, mtu: 517 }; },
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
const profile = (version = "v1.2.0", calls = [{ method: "config.set", params: { led: { blink_hz: 4 } } }]) => ({
  id: crypto.randomUUID(), name: "fast-blink", app: "hs_advertiser", version, config_id: null, config_name: "fast",
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
      flashFn: async (n, img) => { flashed.push(p.version); n.dev.version = opts.flashTo ?? p.version; n.rpc = null; },
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
  assert.match(rec.error, /came back on v1.2.0/);
  ok("deploy: node returning on the wrong version (rollback) is a failure");
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

console.log(`\n${passed} test groups passed`);
