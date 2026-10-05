// Fleet overview model: joins the deployment history (per device ID) with the
// scanner's network metrics (per BLE address) and groups devices by their
// current profile. Pure function, so it runs under Node tests.

/** BLE address for a device ID when a record predates ble_address: ESP32 BT MAC = factory MAC + 2. */
export function derivedBleAddress(deviceId) {
  const n = (BigInt("0x" + deviceId) + 2n) & 0xffffffffffffn;
  return n.toString(16).padStart(12, "0").toUpperCase().match(/../g).join(":");
}

/** Device ID for a BLE address (the inverse): factory MAC = BT MAC - 2. */
export function deviceIdFor(address) {
  const n = (BigInt("0x" + address.replaceAll(":", "")) - 2n) & 0xffffffffffffn;
  return n.toString(16).padStart(12, "0");
}

/** Names are 1-20 letters, numbers, '.', '-' or '_', unique in the fleet ignoring capitals. */
export const NAME_RE = /^[A-Za-z0-9._-]{1,20}$/;

/** Last-seen health: ok < 30 s, stale < 5 min, else lost. */
export function seenState(lastSeenIso, now = Date.now()) {
  if (!lastSeenIso) return "lost";
  const age = (now - Date.parse(lastSeenIso)) / 1000;
  return age < 30 ? "ok" : age < 300 ? "stale" : "lost";
}

/**
 * fleetRows: from store.fleet() ({device_id, latest, lastGood, history})
 * metrics:   from /api/fleet/metrics ([{address, board_id, last_seen, ...}])
 * profiles:  all profile records (to show radio stack / config on group headers)
 * -> {groups: [{key, profile, name, devices: [{device_id, ble_address, board_id, latest, metrics, history}]}],
 *     unprovisioned: [metrics rows whose address no deployed device has]}
 * Groups are sorted by profile name ("no profile" last); devices by board ID.
 */
export function buildFleetView(fleetRows, metrics = [], profiles = [], names = {}) {
  const byAddr = new Map(metrics.map(m => [m.address, m]));
  const byProfile = new Map(profiles.map(p => [p.id, p]));
  const used = new Set();
  const groups = new Map();

  for (const f of fleetRows) {
    // the profile a device is "on" is its last successful deploy (a failed one doesn't change the node)
    const current = f.lastGood ?? f.latest;
    const ble = f.latest.ble_address ?? f.history.find(d => d.ble_address)?.ble_address ?? derivedBleAddress(f.device_id);
    const m = byAddr.get(ble) ?? null;
    if (m) used.add(ble);
    const key = current.profile_id ?? `name:${current.profile_name ?? ""}`;
    if (!groups.has(key)) {
      const p = byProfile.get(current.profile_id) ?? null;
      groups.set(key, {
        key, profile: p,
        name: current.profile_name ?? "no profile",
        app: current.app, version: current.version,
        rf_stack: p?.rf_stack ?? current.rf_stack ?? null,
        config_name: p?.config_name ?? null,
        devices: [],
      });
    }
    groups.get(key).devices.push({
      device_id: f.device_id, ble_address: ble, name: names[f.device_id] ?? null,
      board_id: m?.board_id ?? f.latest.board_id ?? null,
      current, latest: f.latest, history: f.history, metrics: m,
    });
  }

  const sorted = [...groups.values()].sort((a, b) =>
    (a.name === "no profile") - (b.name === "no profile") || a.name.localeCompare(b.name));
  for (const g of sorted) g.devices.sort((a, b) => (a.board_id ?? 999) - (b.board_id ?? 999) || a.device_id.localeCompare(b.device_id));
  const unprovisioned = metrics.filter(m => !used.has(m.address))
    .map(m => ({ ...m, device_id: deviceIdFor(m.address), name: names[deviceIdFor(m.address)] ?? null }))
    .sort((a, b) => (a.board_id ?? 999) - (b.board_id ?? 999));
  return { groups: sorted, unprovisioned };
}
