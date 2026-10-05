// home_state BLE OTA client, protocol v1 (docs/ota-protocol.md). Same protocol as tools/ota_client.py.
// Needs Web Bluetooth: Chrome on Android over HTTPS.

const uuid = i => `2727b0${i.toString(16).padStart(2, "0")}-1ada-46ff-8cde-9e8f32a32c1a`;
export const SVC = uuid(0), INFO = uuid(1), CTRL = uuid(2), DATA = uuid(3);

const CMD = { BEGIN: 1, END: 2, APPLY: 3, ABORT: 4, SYNC: 5 };
const RSP = { BEGIN: 0x81, END: 0x82, APPLY: 0x83, ABORT: 0x84, SYNC: 0x85, NAK: 0x91 };
const STATUS = ["OK", "BAD_STATE", "TOO_BIG", "FLASH", "BAD_OFFSET", "HASH", "IMAGE_INVALID", "WRONG_PROJECT", "BAD_CMD"];

export class OtaError extends Error {}

// ---- image helpers ----

const cstr = (bytes, off, n) => new TextDecoder().decode(bytes.subarray(off, off + n)).split("\0")[0];

/** Project/version/IDF from an ESP-IDF app image (esp_app_desc_t at offset 32). */
export function parseImage(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (b.length < 208 || b[0] !== 0xe9 || dv.getUint32(32, true) !== 0xabcd5432) {
    throw new OtaError("Not an ESP-IDF firmware image");
  }
  return { version: cstr(b, 48, 32), project: cstr(b, 80, 32), idf: cstr(b, 144, 32), size: b.length };
}

export async function sha256(buf) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

// ---- node connection ----

export class Node {
  constructor(device) {
    this.device = device;
    this.replies = [];
    this.waiters = [];
  }

  static async choose() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "hs-" }],
      optionalServices: [SVC],
    });
    const node = new Node(device);
    await node.connect();
    return node;
  }

  async connect() {
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    this.info = await svc.getCharacteristic(INFO);
    this.ctrl = await svc.getCharacteristic(CTRL);
    this.data = await svc.getCharacteristic(DATA);
    this.ctrl.addEventListener("characteristicvaluechanged", e => this.onReply(new Uint8Array(e.target.value.buffer)));
    await this.ctrl.startNotifications();
  }

  get connected() { return this.device.gatt.connected; }

  disconnect() { if (this.connected) this.device.gatt.disconnect(); }

  async readInfo() {
    const v = await this.info.readValue();
    return JSON.parse(new TextDecoder().decode(v.buffer));
  }

  /** CTRL notification from the node (public so tests can feed it). */
  onReply(r) {
    const w = this.waiters.shift();
    if (w) w(r); else this.replies.push(r);
  }

  #next(timeoutMs) {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== done);
        reject(new OtaError("Node did not reply (timeout)"));
      }, timeoutMs);
      const done = r => { clearTimeout(t); resolve(r); };
      this.waiters.push(done);
    });
  }

  /** Wait for a reply of `type`; a NAK means the node aborted the transfer. */
  async expect(type, timeoutMs = 10000) {
    for (;;) {
      const r = await this.#next(timeoutMs);
      if (r[0] === RSP.NAK) throw new OtaError(`Node aborted: ${STATUS[r[1]] ?? r[1]}`);
      if (r[0] !== type) continue;
      if (r[1] !== 0) throw new OtaError(`Node replied ${STATUS[r[1]] ?? r[1]}`);
      return new DataView(r.buffer, r.byteOffset + 2);
    }
  }

  checkNak() {
    while (this.replies.length) {
      const r = this.replies.shift();
      if (r[0] === RSP.NAK) throw new OtaError(`Node aborted: ${STATUS[r[1]] ?? r[1]}`);
    }
  }

  async cmd(bytes) { await this.ctrl.writeValueWithResponse(bytes); }
}

// ---- transfer ----

/**
 * Flash `buf` to the node. progress({sent, total, rate}) is called after every burst.
 * Returns once the node has verified the image and accepted APPLY (it then reboots).
 */
export async function flash(node, buf, { onProgress = () => {}, onLog = () => {}, withResponse = false } = {}) {
  const img = new Uint8Array(buf);
  const hash = await sha256(buf);

  const begin = new Uint8Array(37);
  begin[0] = CMD.BEGIN;
  new DataView(begin.buffer).setUint32(1, img.length, true);
  begin.set(hash, 5);
  await node.cmd(begin);
  const b = await node.expect(RSP.BEGIN);
  const chunk = b.getUint16(0, true), window = b.getUint16(2, true);
  onLog(`BEGIN ok: chunk ${chunk} B, window ${window}${withResponse ? ", write with response" : ""}`);

  const t0 = performance.now();
  let offset = 0, failures = 0;
  while (offset < img.length) {
    try {
      for (let i = 0; i < window && offset < img.length; i++) {
        const data = img.subarray(offset, offset + chunk);
        const pkt = new Uint8Array(4 + data.length);
        new DataView(pkt.buffer).setUint32(0, offset, true);
        pkt.set(data, 4);
        // strictly one GATT operation at a time: Chrome rejects overlapping ones
        if (withResponse) await node.data.writeValueWithResponse(pkt);
        else await node.data.writeValueWithoutResponse(pkt);
        offset += data.length;
      }
      failures = 0;
    } catch (e) {
      if (!node.connected) throw new OtaError("Connection lost during transfer");
      failures++;
      onLog(`write failed (${e.message}); resyncing`);
      if (failures >= 3 && !withResponse) {
        withResponse = true;
        onLog("switching to write-with-response (slower, more reliable)");
      }
      await new Promise(r => setTimeout(r, 200));
    }
    // ask the node where it really is; resume from there
    node.checkNak();
    await node.cmd(new Uint8Array([CMD.SYNC]));
    const received = (await node.expect(RSP.SYNC)).getUint32(0, true);
    if (received !== offset) onLog(`node has ${received} of ${offset} bytes sent: resending from ${received}`);
    offset = received;
    const secs = (performance.now() - t0) / 1000;
    onProgress({ sent: offset, total: img.length, rate: offset / secs });
  }
  onLog(`sent ${img.length} bytes in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  await node.cmd(new Uint8Array([CMD.END]));
  await node.expect(RSP.END, 20000);
  onLog("END ok: node verified the SHA-256 and the image");
  await node.cmd(new Uint8Array([CMD.APPLY]));
  await node.expect(RSP.APPLY);
  onLog("APPLY ok: node is rebooting into the new firmware");
}

/** After APPLY: reconnect to the same device until it answers, then return its INFO. */
export async function reconnectInfo(node, { tries = 30, delayMs = 2000, onLog = () => {} } = {}) {
  for (let i = 1; i <= tries; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    try {
      await node.connect();
      return await node.readInfo();
    } catch (e) {
      onLog(`reconnect ${i}/${tries}: ${e.message}`);
    }
  }
  throw new OtaError("Node did not come back within a minute");
}
