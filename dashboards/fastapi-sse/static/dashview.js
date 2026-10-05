// Dashboard data model (pure, tested in Node): readings -> per-board series on one
// shared time axis, stable colours per board, and range trimming.

// colours chosen to read well on the Lacuna indigo background
export const PALETTE = ["#88DFC3", "#FFC857", "#FF8FA3", "#7AA2FF", "#C49BFF", "#5BE38F", "#FF9F5A", "#E2E2F0"];

export const RANGES = { "15 min": 15, "1 h": 60, "6 h": 360, "24 h": 1440 };

/** Stable colour per board: by board name order, so hs-01 keeps its colour whichever boards are shown. */
export function colours(boards) {
  return Object.fromEntries([...boards].sort().map((b, i) => [b, PALETTE[i % PALETTE.length]]));
}

/** Group readings ([{label|board, received_at, temp_c, rssi}]) by device label (its fleet name, else hs-NN),
 *  into {label: {t: [s], temp: [], rssi: []}}, time-sorted. */
export function byBoard(rows) {
  const out = {};
  for (const r of [...rows].sort((a, b) => a.received_at.localeCompare(b.received_at))) {
    const s = (out[r.label ?? r.board] ??= { t: [], temp: [], rssi: [] });
    s.t.push(Date.parse(r.received_at) / 1000);
    s.temp.push(r.temp_c);
    s.rssi.push(r.rssi);
  }
  return out;
}

/** Drop points older than `minutes` before `nowS` (seconds), in place. */
export function trim(series, minutes, nowS = Date.now() / 1000) {
  const cut = nowS - minutes * 60;
  for (const s of Object.values(series)) {
    let i = 0;
    while (i < s.t.length && s.t[i] < cut) i++;
    if (i) for (const k of ["t", "temp", "rssi"]) s[k].splice(0, i);
  }
  return series;
}

/**
 * uPlot data for one metric across boards on a shared x axis:
 * [[t...], [board1 values or null...], [board2 ...], ...] with boards in `order`.
 * A board has a value only at its own timestamps (null elsewhere; the chart bridges gaps).
 */
export function aligned(series, order, metric) {
  const ts = [...new Set(order.flatMap(b => series[b]?.t ?? []))].sort((a, b) => a - b);
  const index = new Map(ts.map((t, i) => [t, i]));
  const cols = order.map(b => {
    const col = new Array(ts.length).fill(null);
    const s = series[b];
    if (s) s.t.forEach((t, i) => { col[index.get(t)] = s[metric][i]; });
    return col;
  });
  return [ts, ...cols];
}

/** Latest reading per board: {board: {t, temp, rssi}}. */
export function latest(series) {
  return Object.fromEntries(Object.entries(series).filter(([, s]) => s.t.length).map(([b, s]) => {
    const i = s.t.length - 1;
    return [b, { t: s.t[i], temp: s.temp[i], rssi: s.rssi[i] }];
  }));
}
