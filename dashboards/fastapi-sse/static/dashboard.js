// Live dashboard: per-board charts with device toggles, time ranges and the alert
// threshold line. History from /api/readings, live rows from the SSE stream.
import { RANGES, aligned, byBoard, colours, latest, trim } from "./dashview.js";

const $ = id => document.getElementById(id);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  range: store.get("dash.range", "1 h"),
  hidden: new Set(store.get("dash.hidden", [])), // boards switched off (new boards show by default)
  series: {},
  threshold: null,
  charts: {},
  boardsKey: "",
  pushed: 0,
};

// ---------- threshold line (a uPlot plugin) ----------

function thresholdPlugin() {
  return {
    hooks: {
      draw: [u => {
        if (state.threshold == null) return;
        const y = u.valToPos(state.threshold, "y", true);
        if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) return;
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = css("--bad");
        ctx.lineWidth = 1.5 * devicePixelRatio;
        ctx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
        ctx.beginPath();
        ctx.moveTo(u.bbox.left, y);
        ctx.lineTo(u.bbox.left + u.bbox.width, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = css("--bad");
        ctx.font = `${12 * devicePixelRatio}px system-ui, sans-serif`;
        ctx.textAlign = "right";
        ctx.fillText(`alert ${state.threshold} °C`, u.bbox.left + u.bbox.width - 4, y - 4 * devicePixelRatio);
        ctx.restore();
      }],
    },
  };
}

// ---------- charts ----------

function boards() {
  return Object.keys(state.series).sort();
}

function build() {
  const order = boards();
  const col = colours(order);
  for (const c of Object.values(state.charts)) c.destroy();
  state.charts = {};
  const mk = (el, title, unit, metric, extra = {}) => new uPlot({
    title, width: el.clientWidth, height: 280,
    scales: { x: { time: true }, y: extra.yRange ? { range: extra.yRange } : {} },
    axes: [{ stroke: css("--muted"), grid: { stroke: css("--line"), width: 1 } },
           { stroke: css("--muted"), grid: { stroke: css("--line"), width: 1 }, label: unit, size: 56 }],
    series: [{}, ...order.map(b => ({
      label: b, stroke: col[b], width: 2, show: !state.hidden.has(b), spanGaps: true,
      points: { show: metric === "rssi", size: 4, fill: col[b] },
      paths: metric === "rssi" ? () => null : undefined,
      value: (u, v) => (v == null ? "–" : `${v} ${unit}`),
    }))],
    legend: { show: false },
    cursor: { drag: { x: true, y: false } },
    plugins: extra.plugins ?? [],
  }, aligned(state.series, order, metric), el);
  state.charts.temp = mk($("temp-chart"), "Chip temperature", "°C", "temp", {
    plugins: [thresholdPlugin()],
    // keep the threshold line in view
    yRange: (u, min, max) => {
      const lo = Math.min(min ?? 20, state.threshold ?? min ?? 20) - 1;
      const hi = Math.max(max ?? 40, state.threshold ?? max ?? 40) + 1;
      return [Math.floor(lo), Math.ceil(hi)];
    },
  });
  state.charts.rssi = mk($("rssi-chart"), "Signal strength", "dBm", "rssi");
  state.boardsKey = order.join(",");
  renderChips();
}

function redraw() {
  if (boards().join(",") !== state.boardsKey) { build(); return; } // a new board appeared
  const order = boards();
  state.charts.temp?.setData(aligned(state.series, order, "temp"));
  state.charts.rssi?.setData(aligned(state.series, order, "rssi"));
  renderChips();
}
let redrawPending = false;
function scheduleRedraw() {
  if (redrawPending) return;
  redrawPending = true;
  setTimeout(() => { redrawPending = false; redraw(); }, 500);
}

// ---------- device chips + range buttons ----------

function renderChips() {
  const order = boards();
  const col = colours(order);
  const last = latest(state.series);
  $("chips").replaceChildren(...order.map((b, i) => {
    const on = !state.hidden.has(b);
    const l = last[b];
    const age = l ? Math.round(Date.now() / 1000 - l.t) : null;
    const el = document.createElement("button");
    el.className = `chip${on ? " on" : ""}`;
    el.setAttribute("aria-pressed", on);
    el.style.setProperty("--c", col[b]);
    el.title = on ? `hide ${b}` : `show ${b}`;
    el.innerHTML = `<span class="sw"></span><b></b><span class="cv"></span>`;
    el.querySelector("b").textContent = b;
    el.querySelector(".cv").textContent = l
      ? `${l.temp == null ? "–" : l.temp.toFixed(1) + " °C"} · ${l.rssi} dBm · ${age < 60 ? age + " s" : Math.round(age / 60) + " min"} ago`
      : "no data in range";
    el.addEventListener("click", () => {
      on ? state.hidden.add(b) : state.hidden.delete(b);
      store.set("dash.hidden", [...state.hidden]);
      for (const c of Object.values(state.charts)) c.setSeries(i + 1, { show: !state.hidden.has(b) });
      renderChips();
    });
    return el;
  }));
  if (!order.length) $("chips").textContent = "No readings in this range.";
}

function renderRanges() {
  $("ranges").replaceChildren(...Object.keys(RANGES).map(r => {
    const b = document.createElement("button");
    b.textContent = r;
    b.className = r === state.range ? "active" : "";
    b.addEventListener("click", () => { state.range = r; store.set("dash.range", r); renderRanges(); load(); });
    return b;
  }));
}

// ---------- data ----------

async function load() {
  const rows = await (await fetch(`api/readings?minutes=${RANGES[state.range]}`)).json();
  state.series = byBoard(rows);
  build();
}

async function loadThreshold() {
  try {
    const c = await (await fetch("api/alerts/config")).json();
    if (c.threshold_c !== state.threshold) {
      state.threshold = c.threshold_c;
      $("threshold-note").textContent = `Alert threshold ${c.threshold_c} °C (set in the Provision app)`;
      Object.values(state.charts).forEach(ch => ch.redraw());
      state.charts.temp?.setData(aligned(state.series, boards(), "temp")); // re-fit the y range
    }
  } catch { /* keep the last value */ }
}

function connect() {
  const es = new EventSource("api/stream");
  es.onopen = () => { $("dot").className = "dot on"; $("conn").textContent = "live"; };
  es.onerror = () => { $("dot").className = "dot"; $("conn").textContent = "reconnecting…"; };
  es.addEventListener("reading", e => {
    const r = JSON.parse(e.data);
    const s = (state.series[r.board] ??= { t: [], temp: [], rssi: [] });
    s.t.push(Date.parse(r.received_at) / 1000);
    s.temp.push(r.temp_c);
    s.rssi.push(r.rssi);
    trim(state.series, RANGES[state.range]);
    $("t-pushed").textContent = ++state.pushed;
    scheduleRedraw();
  });
}

new ResizeObserver(() => {
  for (const [k, c] of Object.entries(state.charts)) c.setSize({ width: $(`${k}-chart`).clientWidth, height: 280 });
}).observe($("temp-chart"));
setInterval(renderChips, 5000);       // keep "seen N s ago" fresh
setInterval(loadThreshold, 30000);    // follow threshold changes made in the app

renderRanges();
await loadThreshold();
await load();
connect();
