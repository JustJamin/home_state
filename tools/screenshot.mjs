// Screenshot a home_state page with headless Chromium, in real time, via the DevTools protocol.
//   node tools/screenshot.mjs <url> <out.png> [waitMs=8000] [width=420] [height=900]
//   e.g. node tools/screenshot.mjs http://127.0.0.1:30304/admin /tmp/admin.png
// Prints {readyMs, step, fatal}: how long the Admin app took to start (window.__appReady),
// its start-up step and any start-up message on screen.
// Not `chromium --screenshot --timeout=N`: that fast-forwards page timers without waiting for the
// network, so live data never arrives ("connecting…", an empty Admin app).
// Needs /usr/bin/chromium and node 22+ (global fetch + WebSocket); no npm packages.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out, waitMs = "8000", w = "420", h = "900"] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chr-"));
const chrome = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, `--window-size=${w},${h}`, "about:blank"], { stdio: "ignore" }); // keep TMPDIR short: Chromium's socket path has a length limit
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page"); } catch { /* not up yet */ }
    if (!target) await sleep(200);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m.result); });
  const cdp = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  const t0 = Date.now();
  await cdp("Page.navigate", { url });
  let ready = null;
  while (Date.now() - t0 < +waitMs) {
    const r = await cdp("Runtime.evaluate", { expression: "window.__appReady === true" });
    if (ready === null && r?.result?.value) ready = Date.now() - t0;
    await sleep(100);
  }
  const state = await cdp("Runtime.evaluate", { returnByValue: true, expression:
    "({step: window.__step, fatal: document.getElementById('fatal')?.style.display === 'block' ? document.getElementById('fatal').textContent : null})" });
  console.log(JSON.stringify({ readyMs: ready, ...state?.result?.value }));
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
