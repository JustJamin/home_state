// A live per-board chart with its own controls: time-range buttons, show/hide chips per
// board (remembered), one coloured line per board, live rows from the SSE stream.
// Used by the dashboard (temperature, with the alert threshold line) and by the Admin
// app's Fleet tab (signal strength).
import { RANGES, aligned, byBoard, colours, latest, trim } from "./dashview.js";

const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const mem = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/**
 * mount({root, metric: "temp"|"rssi", title, unit, key, threshold?: () => number|null})
 * root gets: range buttons, chips, the chart. Returns {reload(), redraw(), destroy()}.
 */
export function mount({ root, metric, title, unit, key, threshold = () => null, height = 280 }) {
  const state = {
    range: mem.get(`${key}.range`, "1 h"),
    hidden: new Set(mem.get(`${key}.hidden`, [])),
    series: {},
    chart: null,
    boardsKey: "",
    es: null,
  };
  root.replaceChildren();
  const bar = el("div", "lc-bar");
  const ranges = el("div", "seg");
  ranges.setAttribute("role", "group");
  ranges.setAttribute("aria-label", `${title} time range`);
  const chips = el("div", "lc-chips");
  const plot = el("div", "lc-plot");
  bar.append(ranges);
  root.append(bar, chips, plot);

  function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }
  const boards = () => Object.keys(state.series).sort();

  function thresholdPlugin() {
    return { hooks: { draw: [u => {
      const t = threshold();
      if (t == null) return;
      const y = u.valToPos(t, "y", true);
      if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) return;
      const ctx = u.ctx, dpr = devicePixelRatio;
      ctx.save();
      ctx.strokeStyle = css("--bad");
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(u.bbox.left, y); ctx.lineTo(u.bbox.left + u.bbox.width, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css("--bad");
      ctx.font = `${12 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.fillText(`alert ${t} ${unit}`, u.bbox.left + u.bbox.width - 4, y - 4 * dpr);
      ctx.restore();
    }] } };
  }

  function build() {
    if (!window.uPlot) { plot.textContent = "Chart library unavailable."; return; }
    const order = boards();
    const col = colours(order);
    state.chart?.destroy();
    const withLine = metric === "temp";
    state.chart = new uPlot({
      title, width: Math.max(plot.clientWidth, 280), height,
      scales: { x: { time: true }, y: withLine ? { range: (u, min, max) => {
        const t = threshold();
        const lo = Math.min(min ?? 20, t ?? min ?? 20) - 1, hi = Math.max(max ?? 40, t ?? max ?? 40) + 1;
        return [Math.floor(lo), Math.ceil(hi)];
      } } : {} },
      axes: [{ stroke: css("--muted"), grid: { stroke: css("--line"), width: 1 } },
             { stroke: css("--muted"), grid: { stroke: css("--line"), width: 1 }, label: unit, size: 56 }],
      series: [{}, ...order.map(b => ({
        label: b, stroke: col[b], width: 2, show: !state.hidden.has(b), spanGaps: true,
        points: { show: !withLine, size: 4, fill: col[b] },
        paths: withLine ? undefined : () => null,
        value: (u, v) => (v == null ? "–" : `${v} ${unit}`),
      }))],
      legend: { show: false },
      cursor: { drag: { x: true, y: false } },
      plugins: withLine ? [thresholdPlugin()] : [],
    }, aligned(state.series, order, metric), plot);
    state.boardsKey = order.join(",");
    renderChips();
  }

  function redraw() {
    if (boards().join(",") !== state.boardsKey || !state.chart) { build(); return; }
    state.chart.setData(aligned(state.series, boards(), metric));
    renderChips();
  }
  let pending = false;
  function scheduleRedraw() {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; redraw(); }, 500);
  }

  function renderChips() {
    const order = boards();
    const col = colours(order);
    const last = latest(state.series);
    chips.replaceChildren(...order.map((b, i) => {
      const on = !state.hidden.has(b);
      const l = last[b];
      const age = l ? Math.round(Date.now() / 1000 - l.t) : null;
      const v = l ? (metric === "temp" ? (l.temp == null ? "–" : `${l.temp.toFixed(1)} °C`) : `${l.rssi} dBm`) : null;
      const c = document.createElement("button");
      c.className = `chip${on ? " on" : ""}`;
      c.setAttribute("aria-pressed", on);
      c.style.setProperty("--c", col[b]);
      c.title = on ? `hide ${b}` : `show ${b}`;
      const sw = el("span", "sw"), name = document.createElement("b"), cv = el("span", "cv");
      name.textContent = b;
      cv.textContent = l ? `${v} · ${age < 60 ? age + " s" : Math.round(age / 60) + " min"} ago` : "no data in range";
      c.append(sw, name, cv);
      c.addEventListener("click", () => {
        on ? state.hidden.add(b) : state.hidden.delete(b);
        mem.set(`${key}.hidden`, [...state.hidden]);
        state.chart?.setSeries(i + 1, { show: !state.hidden.has(b) });
        renderChips();
      });
      return c;
    }));
    if (!order.length) chips.textContent = "No readings in this range.";
  }

  function renderRanges() {
    ranges.replaceChildren(...Object.keys(RANGES).map(r => {
      const b = document.createElement("button");
      b.textContent = r;
      b.className = r === state.range ? "active" : "";
      b.addEventListener("click", () => { state.range = r; mem.set(`${key}.range`, r); renderRanges(); reload(); });
      return b;
    }));
  }

  async function reload() {
    try {
      const rows = await (await fetch(`/api/readings?minutes=${RANGES[state.range]}`)).json();
      state.series = byBoard(rows);
      build();
    } catch {
      chips.textContent = "Offline: no readings to chart.";
    }
  }

  function connect() {
    if (state.es || typeof EventSource === "undefined") return state.es;
    state.es = new EventSource("/api/stream");
    state.es.addEventListener("reading", e => {
      const r = JSON.parse(e.data);
      const s = (state.series[r.board] ??= { t: [], temp: [], rssi: [] });
      s.t.push(Date.parse(r.received_at) / 1000);
      s.temp.push(r.temp_c);
      s.rssi.push(r.rssi);
      trim(state.series, RANGES[state.range]);
      scheduleRedraw();
    });
    return state.es;
  }

  // optional browser APIs: a missing one must not take the page down with it
  const ro = typeof ResizeObserver === "undefined" ? null
    : new ResizeObserver(() => state.chart?.setSize({ width: Math.max(plot.clientWidth, 280), height }));
  ro?.observe(plot);
  const tick = setInterval(renderChips, 5000);
  renderRanges();

  return {
    reload, redraw, connect,
    refit() { state.chart?.setData(aligned(state.series, boards(), metric)); state.chart?.redraw(); },
    destroy() { clearInterval(tick); ro?.disconnect(); state.es?.close(); state.es = null; state.chart?.destroy(); state.chart = null; },
    get stream() { return state.es; },
  };
}
