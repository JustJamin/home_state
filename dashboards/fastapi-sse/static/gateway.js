// Phone gateway (manual collect): read a node's buffered readings over BLE JSON-RPC
// (readings.read), keep them on the phone, and upload them when online.
//   - per device, a cursor {boot_id, after_uptime_s} remembers what's been collected;
//     a different boot_id means the node rebooted, so collection restarts from its oldest
//   - nodes have no clock: received_at = phone time at collection - (node uptime now - uptime then)
//   - each row's id is address:boot:uptime, so collecting twice can't duplicate locally;
//     the server also skips readings it already has (e.g. the scanner heard them)

const boardName = id => `hs-${String(id).padStart(2, "0")}`;
const PAGE = 50;

/** Collect everything new from a connected node. Returns {device_id, collected, buffered}. */
export async function collect(node, store, { log = () => {}, now = () => Date.now() } = {}) {
  if (!node.rpc) throw new Error("this node's firmware has no JSON-RPC (it needs v1.3.1 or later)");
  const info = await node.rpc.call("device.info");
  if (!info.ble_address) throw new Error("this node's firmware doesn't report its BLE address (needs v1.3.0+)");
  const key = `gw:${info.device_id}`;
  let cursor = (await store.getMeta(key)) ?? null;
  let collected = 0, buffered = 0, more = true;
  while (more) {
    const params = { limit: PAGE };
    if (cursor) {
      params.boot_id = cursor.boot_id;
      if (cursor.after_uptime_s >= 0) params.after_uptime_s = cursor.after_uptime_s; // -1: nothing collected this boot yet
    }
    let r;
    try {
      r = await node.rpc.call("readings.read", params);
    } catch (e) {
      if (e.code === -32601) throw new Error(`${info.app} ${info.version} has no readings buffer: the gateway needs firmware v1.3.1 or later`);
      throw e;
    }
    const at = now();
    if (cursor && !r.same_boot) log(`${boardName(r.board_id)} rebooted since the last collect: taking all it has`);
    for (const x of r.readings) {
      const id = `${info.ble_address}:${r.boot_id}:${x.u}`;
      await store.put("gateway", {
        id, address: info.ble_address, board_id: r.board_id, name: boardName(r.board_id), counter: x.c,
        temp_c: x.t, uptime_s: x.u, received_at: new Date(at - (r.now_uptime_s - x.u) * 1000).toISOString(),
        device_id: info.device_id, collected_at: new Date(at).toISOString(),
      });
    }
    collected += r.readings.length;
    buffered = r.buffered;
    if (r.readings.length) cursor = { boot_id: r.boot_id, after_uptime_s: r.readings.at(-1).u };
    else if (!cursor || !r.same_boot) cursor = { boot_id: r.boot_id, after_uptime_s: -1 };
    more = r.more;
  }
  await store.setMeta(key, { ...cursor, last_collect: new Date(now()).toISOString(), name: boardName(info.board_id), collected });
  log(`collected ${collected} reading(s) from ${boardName(info.board_id)} (it holds the last ${buffered})`);
  return { device_id: info.device_id, collected, buffered };
}

/** Upload collected readings in batches; uploaded ones are removed from the phone. */
export async function upload(store, { fetchFn = (...a) => fetch(...a), batch = 500 } = {}) {
  const rows = (await store.all("gateway")).sort((a, b) => a.received_at.localeCompare(b.received_at));
  let inserted = 0, duplicates = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch);
    const r = await fetchFn("api/gateway/readings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readings: part.map(({ address, board_id, name, counter, temp_c, uptime_s, received_at }) =>
        ({ address, board_id, name, counter, temp_c, uptime_s, received_at })), client: "provision/gateway" }),
    });
    if (!r.ok) throw new Error(`gateway upload failed: HTTP ${r.status}`);
    const res = await r.json();
    inserted += res.inserted;
    duplicates += res.duplicates;
    for (const row of part) await store.delete("gateway", row.id); // only after the server has them
  }
  return { inserted, duplicates, uploaded: rows.length };
}
