// Server Temp dashboard: live chip temperature per board, with the alert threshold line.
// (Signal strength lives at the bottom of the Admin app's Fleet tab.)
import { mount } from "./livechart.js";

const $ = id => document.getElementById(id);
let threshold = null;
let pushed = 0;

const temp = mount({
  root: $("temp"), metric: "temp", title: "Server temperature", unit: "°C", key: "dash.temp",
  threshold: () => threshold,
});

async function loadThreshold() {
  try {
    const c = await (await fetch("/api/alerts/config")).json();
    if (c.threshold_c !== threshold) {
      threshold = c.threshold_c;
      $("threshold-note").textContent = `Alert threshold ${c.threshold_c} °C (set in Admin)`;
      temp.refit();
    }
  } catch { /* keep the last value */ }
}

await loadThreshold();
await temp.reload();
const es = temp.connect();
es.onopen = () => { $("dot").className = "dot on"; $("conn").textContent = "live"; };
es.onerror = () => { $("dot").className = "dot"; $("conn").textContent = "reconnecting…"; };
es.addEventListener("reading", () => { $("t-pushed").textContent = ++pushed; });
setInterval(loadThreshold, 30000); // follow threshold changes made in Admin
