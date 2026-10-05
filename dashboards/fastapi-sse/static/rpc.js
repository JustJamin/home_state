// JSON-RPC 2.0 over the node's BLE RPC characteristic (docs/jsonrpc.md).
// Messages are framed [u8 flags][bytes]: 0x02 START, 0x01 FINAL.

export const RPC_UUID = "2727b004-1ada-46ff-8cde-9e8f32a32c1a";
const F_FINAL = 0x01, F_START = 0x02;

export class RpcError extends Error {
  constructor({ code, message, data }) {
    super(data?.field ? `${message} (${data.field})` : message);
    this.code = code;
    this.data = data;
  }
}

export class Rpc {
  /** char: a characteristic-like object (writeValueWithResponse, startNotifications, events); mtu from INFO. */
  constructor(char, mtu = 23) {
    this.char = char;
    this.frag = Math.min(mtu - 3, 512) - 1;
    this.nextId = 1;
    this.pending = new Map();
    this.partial = [];
    this.queue = Promise.resolve();
  }

  async start() {
    this.char.addEventListener("characteristicvaluechanged", e => this.onNotify(new Uint8Array(e.target.value.buffer)));
    await this.char.startNotifications();
    return this;
  }

  /** Reassemble a framed response and settle the call it answers (public for tests). */
  onNotify(bytes) {
    const flags = bytes[0];
    if (flags & F_START) this.partial = [];
    this.partial.push(bytes.subarray(1));
    if (!(flags & F_FINAL)) return;
    const total = this.partial.reduce((n, p) => n + p.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of this.partial) { all.set(p, off); off += p.length; }
    this.partial = [];
    let msg;
    try { msg = JSON.parse(new TextDecoder().decode(all)); } catch { return; }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new RpcError(msg.error));
    else waiter.resolve(msg.result);
  }

  /** Call `method`; resolves with the result, rejects with RpcError. Calls run one at a time. */
  call(method, params, timeoutMs = 10000) {
    const run = async () => {
      const id = this.nextId++;
      const req = { jsonrpc: "2.0", id, method };
      if (params !== undefined) req.params = params;
      const bytes = new TextEncoder().encode(JSON.stringify(req));
      const done = new Promise((resolve, reject) => {
        const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: no response`)); }, timeoutMs);
        this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      });
      for (let off = 0; off < bytes.length || off === 0; off += this.frag) {
        const part = bytes.subarray(off, off + this.frag);
        const pkt = new Uint8Array(part.length + 1);
        pkt[0] = (off === 0 ? F_START : 0) | (off + this.frag >= bytes.length ? F_FINAL : 0);
        pkt.set(part, 1);
        await this.char.writeValueWithResponse(pkt);
        if (!bytes.length) break;
      }
      return done;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}
