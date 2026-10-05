// Provisioning app UI: Build (app -> version -> config -> profile), Deploy (one-touch), Fleet.
// Works offline: data in IndexedDB (store.js), firmware in Cache Storage (catalogue.js),
// the page itself from the service worker (sw.js). Syncs with the server when reachable.

import { IdbStore, addRecord, archivedIds, fleet } from "./store.js";
import { Sync } from "./sync.js";
import { Catalogue } from "./catalogue.js";
import { validateScript, scriptableMethods } from "./schema.js";
import { Node } from "./ota.js";
import { deploy } from "./deploy.js";

const $ = id => document.getElementById(id);
const CLIENT = `provision/${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "browser"}`;
const DEFAULT = "default";

/** Build a DOM element: h("div", {class: "x", onclick}, "text", child...). Text is never parsed as HTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c?.nodeType ? c : String(c)); // DOM node or text
  return el;
}
const ago = iso => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
const kb = n => `${(n / 1024).toFixed(0)} KB`;

// ---------------- startup ----------------

const store = await IdbStore.open();
const sync = new Sync(store);
const catalogue = new Catalogue(store);
const ui = { apps: [], methods: null, defaultScript: null, configs: [], dirty: false };

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(e => console.warn("sw:", e));
navigator.storage?.persist?.();

if (!navigator.bluetooth) {
  const el = $("unsupported");
  el.textContent = window.isSecureContext
    ? "This browser has no Web Bluetooth: use Chrome on Android. You can still browse and build profiles."
    : "Web Bluetooth needs HTTPS: open https://lenovo.tailc2dfa5.ts.net/provision";
  el.classList.add("show");
}

// ---------------- tabs + status ----------------

for (const b of document.querySelectorAll("nav.tabs button")) {
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll("nav.tabs button")) x.classList.toggle("active", x === b);
    for (const p of document.querySelectorAll("[data-panel]")) p.classList.toggle("hidden", p.dataset.panel !== b.dataset.tab);
    if (b.dataset.tab === "fleet") renderFleet();
  });
}

sync.onChange(s => {
  const on = $("st-online");
  on.textContent = s.online === null ? "…" : s.online ? "● online" : "○ offline";
  on.className = `pill ${s.online ? "on" : s.online === false ? "off" : ""}`;
  $("st-pending").textContent = `${s.pending} to sync`;
  $("st-pending").classList.toggle("hidden", !s.pending);
  $("st-last").textContent = s.lastSync ? `synced ${ago(s.lastSync)}` : "";
});

async function syncNow() {
  const r = await sync.run();
  if (r) {
    if (r.rejected.length) alert(`The server refused ${r.rejected.length} record(s):\n` + r.rejected.map(x => x.errors.join("; ")).join("\n"));
    await refreshAll();
    catalogue.ensureOffline(ui.apps).then(renderProfiles);
  }
}
$("sync-now").addEventListener("click", syncNow);
window.addEventListener("online", syncNow);
setInterval(syncNow, 60000);

// ---------------- Build ----------------

async function renderApps() {
  ui.apps = await catalogue.apps();
  const sel = $("app");
  const prev = sel.value;
  sel.replaceChildren(...ui.apps.map(a => h("option", { value: a.app }, a.app)));
  if (!ui.apps.length) sel.append(h("option", { value: "" }, "no firmware available offline yet"));
  if (prev && ui.apps.some(a => a.app === prev)) sel.value = prev;
  await renderVersions();
}

async function renderVersions() {
  const app = ui.apps.find(a => a.app === $("app").value);
  const sel = $("version");
  const prev = sel.value;
  const opts = [];
  for (const v of app?.versions ?? []) {
    const offline = await catalogue.isOffline(app.app, v.version);
    opts.push(h("option", { value: v.version, disabled: !v.configurable },
      `${v.version}${offline ? " ✓ offline" : ""}${v.configurable ? "" : " (no JSON-RPC)"}`));
  }
  sel.replaceChildren(...opts);
  const first = (app?.versions ?? []).find(v => v.configurable);
  sel.value = prev && app?.versions.some(v => v.version === prev && v.configurable) ? prev : first?.version ?? "";
  await renderVersion();
}

async function renderVersion() {
  const app = $("app").value, version = $("version").value;
  const v = ui.apps.find(a => a.app === app)?.versions.find(x => x.version === version);
  $("config-card").classList.toggle("hidden", !v);
  if (!v) { $("version-info").textContent = "No configurable versions."; return; }
  $("version-info").textContent = `${kb(v.size)} · built ${v.built.replace("T", " ")} · ESP-IDF ${v.idf}`;
  const keep = (await store.getMeta("keepOffline")) ?? [];
  $("keep-offline").checked = keep.includes(`${app}\n${version}`);
  try {
    ui.methods = await catalogue.json(app, version, "methods.json");
    ui.defaultScript = await catalogue.json(app, version, "default.config.json");
  } catch (e) {
    $("version-info").textContent = `Not available offline: ${e.message}`;
    $("config-card").classList.add("hidden");
    return;
  }
  $("methods-ref").replaceChildren(...scriptableMethods(ui.methods).map(m => h("li", {},
    h("code", {}, m.name), m.per_device ? " (per-device: not in shared configs)" : "", ` – ${m.description ?? ""}`,
    m.params?.properties ? h("div", { class: "muted" }, h("code", {}, describeParams(m.params))) : null)));
  await renderConfigs();
}

function describeParams(schema, prefix = "") {
  return Object.entries(schema.properties ?? {}).map(([k, s]) => {
    if (s.type === "object") return describeParams(s, `${prefix}${k}.`);
    const range = s.enum ? s.enum.join("|") : "minimum" in s ? `${s.minimum}–${s.maximum}` : s.type;
    return `${prefix}${k}: ${range}`;
  }).join(", ");
}

async function renderConfigs(selectId) {
  const app = $("app").value, version = $("version").value;
  const archived = await archivedIds(store, "config");
  ui.configs = (await store.all("configs"))
    .filter(c => c.app === app && c.version === version && !archived.has(c.id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const sel = $("config");
  const prev = selectId ?? sel.value;
  sel.replaceChildren(h("option", { value: DEFAULT }, "default (ships with this version)"),
    ...ui.configs.map(c => h("option", { value: c.id }, `${c.name}${c._rejected ? " ⚠ refused by server" : ""}`)));
  sel.value = [DEFAULT, ...ui.configs.map(c => c.id)].includes(prev) ? prev : DEFAULT;
  loadConfigIntoEditor();
}

function selectedConfig() {
  const id = $("config").value;
  if (id === DEFAULT) return { id: null, name: DEFAULT, script: { calls: ui.defaultScript.calls } };
  return ui.configs.find(c => c.id === id);
}

function loadConfigIntoEditor() {
  const c = selectedConfig();
  $("editor").value = JSON.stringify(c.script, null, 2);
  ui.dirty = false;
  $("archive-config").classList.toggle("hidden", c.id === null);
  validateEditor();
}

/** Parse + validate the editor. Returns the script if valid, else null. */
function validateEditor() {
  const out = $("validation");
  let script, errors;
  try {
    script = JSON.parse($("editor").value);
    errors = validateScript(script, ui.methods, true);
  } catch (e) {
    errors = [`not valid JSON: ${e.message}`];
  }
  $("editor").classList.toggle("invalid", errors.length > 0);
  out.replaceChildren(errors.length
    ? h("ul", { class: "errors" }, errors.map(e => h("li", {}, e)))
    : h("div", { class: "valid" }, `✓ valid · ${script.calls.length} call${script.calls.length === 1 ? "" : "s"}${ui.dirty ? " · unsaved changes" : ""}`));
  $("save-config").disabled = errors.length > 0;
  $("save-profile").disabled = errors.length > 0;
  return errors.length ? null : script;
}

$("app").addEventListener("change", renderVersions);
$("version").addEventListener("change", renderVersion);
$("config").addEventListener("change", loadConfigIntoEditor);
$("editor").addEventListener("input", () => { ui.dirty = true; validateEditor(); });

$("keep-offline").addEventListener("change", async e => {
  const key = `${$("app").value}\n${$("version").value}`;
  const keep = new Set((await store.getMeta("keepOffline")) ?? []);
  if (e.target.checked) {
    keep.add(key);
    try { await catalogue.keepOffline($("app").value, $("version").value); } catch (err) { alert(err.message); }
  } else keep.delete(key);
  await store.setMeta("keepOffline", [...keep]);
  renderVersions();
});

async function saveConfig() {
  const script = validateEditor();
  if (!script) return null;
  const name = prompt("Name for this config:", ui.dirty ? "" : `${selectedConfig().name}-copy`)?.trim();
  if (!name) return null;
  const rec = await addRecord(store, "configs", {
    id: crypto.randomUUID(), app: $("app").value, version: $("version").value, name, script: { calls: script.calls },
    created_at: new Date().toISOString(), client: CLIENT,
  });
  await renderConfigs(rec.id);
  sync.refreshPending();
  syncNow();
  return rec;
}
$("save-config").addEventListener("click", saveConfig);

$("save-profile").addEventListener("click", async () => {
  let cfg = selectedConfig();
  if (ui.dirty) {
    if (!confirm("The config has unsaved changes. Save them as a new config first?")) return;
    cfg = await saveConfig();
    if (!cfg) return;
  }
  const version = $("version").value;
  const name = prompt("Name for this profile:", `${cfg.name} @ ${version}`)?.trim();
  if (!name) return;
  await addRecord(store, "profiles", {
    id: crypto.randomUUID(), name, app: $("app").value, version, config_id: cfg.id, config_name: cfg.name,
    script: { calls: cfg.script.calls }, created_at: new Date().toISOString(), client: CLIENT,
  });
  catalogue.keepOffline($("app").value, version).catch(() => {});
  sync.refreshPending();
  await renderProfiles();
  syncNow();
  document.querySelector('nav.tabs button[data-tab="deploy"]').click();
});

$("archive-config").addEventListener("click", async () => {
  const c = selectedConfig();
  if (!c.id || !confirm(`Archive config "${c.name}"? It's hidden from the list but kept in history.`)) return;
  await addRecord(store, "archives", { id: crypto.randomUUID(), kind: "config", record_id: c.id, archived_at: new Date().toISOString(), client: CLIENT });
  await renderConfigs(DEFAULT);
  syncNow();
});

// ---------------- Deploy ----------------

async function renderProfiles() {
  const archived = await archivedIds(store, "profile");
  const profiles = (await store.all("profiles")).filter(p => !archived.has(p.id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (!profiles.length) { $("profiles").replaceChildren("No profiles yet. Make one in Build."); return; }
  const cards = [];
  for (const p of profiles) {
    const offline = await catalogue.isOffline(p.app, p.version);
    cards.push(h("div", { class: "profile" },
      h("div", {}, h("span", { class: "name" }, p.name),
        offline ? h("span", { class: "badge ok" }, "offline ✓") : h("span", { class: "badge warn" }, "needs network"),
        p._rejected ? h("span", { class: "badge bad" }, "refused by server") : null),
      h("div", { class: "actions" },
        h("button", { onclick: () => runDeploy(p), disabled: !navigator.bluetooth }, "Deploy"),
        h("button", { class: "small danger", title: "archive", onclick: () => archiveProfile(p) }, "✕")),
      h("div", { class: "muted" }, `${p.app} ${p.version} · config "${p.config_name}" · ${p.script.calls.length} call(s)`)));
  }
  $("profiles").replaceChildren(...cards);
}

async function archiveProfile(p) {
  if (!confirm(`Archive profile "${p.name}"? Its deployments stay in the fleet history.`)) return;
  await addRecord(store, "archives", { id: crypto.randomUUID(), kind: "profile", record_id: p.id, archived_at: new Date().toISOString(), client: CLIENT });
  renderProfiles();
  syncNow();
}

function runLog(msg) {
  $("run-log").textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  $("run-log").scrollTop = $("run-log").scrollHeight;
}

let deploying = false;
async function runDeploy(profile) {
  if (deploying) return;
  let node;
  try {
    node = await Node.choose(); // first: needs the tap's user activation
  } catch (e) {
    if (e.name !== "NotFoundError") alert(`Couldn't connect: ${e.message}`);
    return;
  }
  deploying = true;
  const boardRaw = $("board-id").value.trim();
  const boardId = boardRaw === "" ? null : Number(boardRaw);
  $("run-card").classList.remove("hidden");
  $("run-title").textContent = `Deploying "${profile.name}" to ${node.device.name}`;
  $("run-log").textContent = "";
  $("run-result").className = "result";
  $("run-progress").classList.add("hidden");
  $("run-rate").textContent = "";
  $("run-card").scrollIntoView({ behavior: "smooth" });
  let lock = null;
  try { lock = await navigator.wakeLock?.request("screen"); } catch { /* not fatal */ }
  const steps = { identify: "Reading device ID…", flash: "Flashing firmware…", board: "Setting board ID…", config: "Applying config…" };
  try {
    const rec = await deploy({
      node, profile, catalogue, store, boardId, client: CLIENT, log: runLog,
      progress: p => {
        if (steps[p.step]) $("run-step").textContent = steps[p.step];
        if (p.step === "flash" && p.total) {
          $("run-progress").classList.remove("hidden");
          $("run-progress").value = p.sent / p.total;
          $("run-rate").textContent = `${kb(p.sent)} / ${kb(p.total)} · ${(p.rate / 1024).toFixed(1)} KB/s`;
        }
      },
    });
    $("run-step").textContent = "";
    const r = $("run-result");
    r.className = `result show ${rec.ok ? "ok" : "bad"}`;
    r.textContent = rec.ok
      ? `✓ ${node.device.name} (device ${rec.device_id}) now runs "${profile.name}"${rec.flashed ? `, flashed ${rec.from_version} → ${rec.version}` : ""}`
      : `✗ ${rec.error}`;
    if (!rec.device_id) r.textContent += " (not recorded: no device ID)";
  } finally {
    lock?.release();
    node.disconnect();
    deploying = false;
    sync.refreshPending();
    syncNow();
  }
}

$("inspect").addEventListener("click", async () => {
  let node;
  try { node = await Node.choose(); } catch (e) { if (e.name !== "NotFoundError") alert(e.message); return; }
  const out = [];
  try {
    if (node.rpc) {
      const info = await node.rpc.call("device.info");
      const status = await node.rpc.call("device.status");
      const config = await node.rpc.call("config.get");
      const last = (await fleet(store)).find(f => f.device_id === info.device_id);
      out.push(["device ID", info.device_id], ["firmware", `${info.app} ${info.version}`],
        ["partition", `${info.partition} (${info.state})`], ["board ID", info.board_id],
        ["uptime", `${status.uptime_s} s`], ["temperature", `${status.temp_c} °C`],
        ["settings", JSON.stringify(config)],
        ["last deploy", last ? `"${last.latest.profile_name}" ${ago(last.latest.finished_at)} ${last.latest.ok ? "✓" : "✗"}` : "none recorded"]);
    } else {
      const i = await node.readInfo();
      out.push(["firmware", `${i.proj} ${i.fw}`], ["partition", `${i.part} (${i.state})`], ["board ID", i.board],
               ["note", "pre-JSON-RPC firmware: no device ID until a profile is deployed"]);
    }
  } catch (e) {
    out.push(["error", e.message]);
  } finally {
    node.disconnect();
  }
  $("inspect-out").replaceChildren(...out.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
});

// ---------------- Fleet ----------------

async function renderFleet() {
  const rows = await fleet(store);
  $("fleet-history").replaceChildren();
  if (!rows.length) {
    $("fleet-rows").replaceChildren(h("tr", {}, h("td", { colspan: 5, class: "muted" }, "No deployments recorded yet.")));
    return;
  }
  $("fleet-rows").replaceChildren(...rows.map(f => h("tr", { class: "device", onclick: () => showHistory(f) },
    h("td", { class: "mono" }, f.device_id),
    h("td", {}, f.latest.board_id ?? "–"),
    h("td", {}, f.latest.profile_name ?? "–", h("div", { class: "muted" }, f.latest.version)),
    h("td", {}, f.latest.ok ? h("span", { class: "badge ok" }, "ok") : h("span", { class: "badge bad" }, "failed")),
    h("td", {}, ago(f.latest.finished_at)))));
}

function showHistory(f) {
  $("fleet-history").replaceChildren(h("h2", { style: "margin-top:14px" }, `History of ${f.device_id}`),
    ...f.history.map(d => h("div", { class: "profile" },
      h("div", {}, h("span", { class: "name" }, d.profile_name ?? "–"),
        d.ok ? h("span", { class: "badge ok" }, "ok") : h("span", { class: "badge bad" }, "failed"),
        d.flashed ? h("span", { class: "badge" }, `flashed ${d.from_version} → ${d.version}`) : null),
      h("div", { class: "muted" }, `${new Date(d.finished_at).toLocaleString()} · board ${d.board_id ?? "–"} · ${d.results.length} call(s)${d.error ? ` · ${d.error}` : ""}`))));
}

// ---------------- go ----------------

async function refreshAll() {
  await renderApps();
  await renderProfiles();
  if (!document.querySelector('[data-panel="fleet"]').classList.contains("hidden")) await renderFleet();
}

await sync.refreshPending();
await refreshAll();
syncNow();
