// Tests static/ota.js against a simulated node that follows firmware/main/ota.c's rules.
// Run: node test_ota.mjs [path/to/hs_advertiser.bin]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Node, flash, parseImage, OtaError } from "./static/ota.js";

const imagePath = process.argv[2] ?? new URL("../../firmware/build/hs_advertiser.bin", import.meta.url).pathname;
const image = readFileSync(imagePath);
const buf = image.buffer.slice(image.byteOffset, image.byteOffset + image.length);

/** Firmware-equivalent node. faults: dropEvery (silently lose every Nth data write), throwEvery, project. */
function mockNode({ dropEvery = 0, throwEvery = 0, project = "hs_advertiser", mtu = 517 } = {}) {
  const fw = { state: "idle", size: 0, received: 0, chunks: [], expectedHash: null, writes: 0 };
  let notify;
  const reply = (type, status, payload = []) => queueMicrotask(() => notify(new Uint8Array([type, status, ...payload])));
  const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
  const chunk = Math.min(mtu - 7, 508);

  const ctrl = {
    addEventListener: (_, fn) => { notify = r => fn({ target: { value: { buffer: r.buffer } } }); },
    startNotifications: async () => {},
    async writeValueWithResponse(p) {
      const dv = new DataView(p.buffer);
      switch (p[0]) {
        case 1: fw.state = "receiving"; fw.size = dv.getUint32(1, true); fw.received = 0; fw.chunks = [];
                fw.expectedHash = Buffer.from(p.subarray(5, 37)).toString("hex");
                return reply(0x81, 0, [chunk & 255, chunk >> 8, 16, 0]);
        case 5: return reply(0x85, fw.state === "idle" ? 1 : 0, u32(fw.received));
        case 2: {
          if (fw.state !== "receiving" || fw.received !== fw.size) return reply(0x82, 1);
          const all = Buffer.concat(fw.chunks);
          const hash = Buffer.from(await crypto.subtle.digest("SHA-256", all)).toString("hex");
          if (hash !== fw.expectedHash) { fw.state = "idle"; return reply(0x82, 5); }
          fw.state = "received"; fw.image = all; return reply(0x82, 0);
        }
        case 3: return reply(0x83, fw.state === "received" ? 0 : 1);
      }
    },
  };
  const onData = p => {
    const off = new DataView(p.buffer, p.byteOffset).getUint32(0, true);
    if (fw.state !== "receiving" || off !== fw.received) return;  // ignored until SYNC
    const data = Buffer.from(p.subarray(4));
    if (fw.received === 0 && project !== "hs_advertiser") { fw.state = "idle"; return reply(0x91, 7, u32(0)); }
    fw.chunks.push(data);
    fw.received += data.length;
  };
  const data = {
    async writeValueWithoutResponse(p) {
      fw.writes++;
      if (throwEvery && fw.writes % throwEvery === 0) throw new Error("GATT operation failed for unknown reason.");
      if (dropEvery && fw.writes % dropEvery === 0) return;  // lost in the air
      onData(p);
    },
    async writeValueWithResponse(p) { fw.writes++; onData(p); },
  };
  const node = new Node({ gatt: { connected: true } });
  Object.assign(node, { ctrl, data });
  ctrl.addEventListener("characteristicvaluechanged", e => node.onReply(new Uint8Array(e.target.value.buffer)));
  return { node, fw };
}

const cases = [
  ["clean transfer", {}],
  ["every 37th write silently dropped", { dropEvery: 37 }],
  ["every 50th write throws", { throwEvery: 50 }],
  ["every write throws (switches to with-response after 3)", { throwEvery: 1 }],
  ["small MTU (23)", { mtu: 23 }],
];
const meta = parseImage(buf);
console.log(`image: ${meta.project} ${meta.version}, ${meta.size} bytes`);
for (const [name, opts] of cases) {
  const { node, fw } = mockNode(opts);
  const logs = [];
  await flash(node, buf, { onLog: m => logs.push(m) });
  assert.equal(fw.state, "received");
  assert.ok(Buffer.compare(fw.image, image) === 0, "image on node differs");
  const resyncs = logs.filter(l => l.includes("resending")).length;
  console.log(`ok  ${name}: ${fw.writes} writes, ${resyncs} resyncs${logs.some(l => l.includes("switching")) ? ", switched to with-response" : ""}`);
}

{
  const { node } = mockNode({ project: "other" });
  await assert.rejects(flash(node, buf, { onLog: () => {} }), e => e instanceof OtaError && /WRONG_PROJECT/.test(e.message));
  console.log("ok  wrong project rejected");
}
{
  const bad = new Uint8Array(buf.slice(0)); bad[0] = 0;
  assert.throws(() => parseImage(bad.buffer), OtaError);
  console.log("ok  non-image rejected by parseImage");
}
