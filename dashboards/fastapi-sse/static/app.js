// Provisioning app UI: Deploy (pick a profile, one-touch), Build (app -> version -> radio
// stack -> config -> profile, with a form builder or raw JSON), Fleet (devices grouped by
// profile, with the scanner's network metrics).
// Works offline: data in IndexedDB (store.js), firmware in Cache Storage (catalogue.js),
// the page itself from the service worker (sw.js). Syncs with the server when reachable.

import { IdbStore, addRecord, archivedIds, fleet } from "./store.js";
import { Sync } from "./sync.js";
import { Catalogue } from "./catalogue.js";
import { validateScript, scriptableMethods } from "./schema.js";
import { Node } from "./ota.js";
import { deploy } from "./deploy.js";
import * as B from "./builder.js";
import { buildFleetView, seenState } from "./fleetview.js";
import * as GW from "./gateway.js";

const $ = id => document.getElementById(id);
const CLIENT = `provision/${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "browser"}`;
const DEFAULT = "default";

/** Build a DOM element: h("div", {class: "x", onclick}, "text", child...). Text is never parsed as HTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = !!v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c?.nodeType ? c : String(c)); // DOM node or text
  return el;
}
const ago = iso => {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return `${Math.max(0, Math.round(s))} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
const kb = n => `${(n / 1024).toFixed(0)} KB`;
const boardName = id => `hs-${String(id).padStart(2, "0")}`;
const pretty = s => JSON.stringify(s, null, 2);
const compact = p => (p === undefined ? "" : JSON.stringify(p));

// ---------------- startup ----------------

const store = await IdbStore.open();
const sync = new Sync(store);
const catalogue = new Catalogue(store);
const ui = {
  apps: [], methods: null, defaultScript: null, configs: [], script: { calls: [] }, dirty: false,
  mode: "form", jsonError: null, target: null, profiles: [], metrics: (await store.getMeta("metrics")) ?? null,
  loadedVersion: null, loadedConfig: null, // what the Build editor currently shows (kept across background refreshes)
  expanded: new Set(),
};

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

function showTab(name) {
  if (name === "gateway") renderGateway();
  for (const x of document.querySelectorAll("nav.tabs button")) x.classList.toggle("active", x.dataset.tab === name);
  for (const p of document.querySelectorAll("[data-panel]")) p.classList.toggle("hidden", p.dataset.panel !== name);
  if (name === "fleet") { renderFleet(); refreshMetrics(); }
  window.scrollTo({ top: 0 });
}
for (const b of document.querySelectorAll("nav.tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));
const fleetVisible = () => !document.querySelector('[data-panel="fleet"]').classList.contains("hidden");

let gwPending = 0; // gateway readings waiting to upload (counted in "to sync")
function renderStatus(s = sync.state) {
  const on = $("st-online");
  on.textContent = s.online === null ? "…" : s.online ? "● online" : "○ offline";
  on.className = `pill ${s.online ? "on" : s.online === false ? "off" : ""}`;
  const n = s.pending + gwPending;
  $("st-pending").textContent = `${n} to sync`;
  $("st-pending").classList.toggle("hidden", !n);
  $("st-last").textContent = s.lastSync ? `synced ${ago(s.lastSync)}` : "";
}
sync.onChange(renderStatus);

async function syncNow() {
  const r = await sync.run();
  if (r) {
    try {
      const up = await GW.upload(store);
      if (up.uploaded) gwLog(`uploaded ${up.uploaded} gateway reading(s): ${up.inserted} new, ${up.duplicates} the server already had`);
    } catch (e) { gwLog(`upload failed: ${e.message}`); }
    await renderGateway();
    loadAlerts();
    if (r.rejected.length) alert(`The server refused ${r.rejected.length} record(s):\n` + r.rejected.map(x => x.errors.join("; ")).join("\n"));
    await refreshAll();
    catalogue.ensureOffline(ui.apps).then(renderProfiles);
  }
}
$("sync-now").addEventListener("click", syncNow);
window.addEventListener("online", syncNow);
setInterval(syncNow, 60000);

// ============================== Build ==============================

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
  if (!v) { $("version-info").textContent = "No configurable versions."; $("rf-wrap").classList.add("hidden"); return; }
  $("version-info").textContent = `${kb(v.size)} · built ${v.built.replace("T", " ")} · ESP-IDF ${v.idf}`;
  const keep = (await store.getMeta("keepOffline")) ?? [];
  $("keep-offline").checked = keep.includes(`${app}\n${version}`);
  const key = `${app}\n${version}`;
  if (key === ui.loadedVersion) {
    // background refresh (sync etc.): keep the radio stack choice and the editor as they are
    await renderConfigs();
    return;
  }
  try {
    ui.methods = await catalogue.json(app, version, "methods.json");
    ui.defaultScript = await catalogue.json(app, version, "default.config.json");
  } catch (e) {
    $("version-info").textContent = `Not available offline: ${e.message}`;
    $("config-card").classList.add("hidden");
    return;
  }
  // radio stack versions this firmware declares (older versions declare none)
  const rf = ui.methods.rf_stacks;
  $("rf-wrap").classList.toggle("hidden", !rf);
  $("rf-stack").replaceChildren(...(rf?.versions ?? []).map(x => h("option", { value: x }, x)));
  if (rf) $("rf-stack").value = rf.default ?? rf.versions[0];

  $("methods-ref").replaceChildren(...scriptableMethods(ui.methods).map(m => h("li", {},
    h("code", {}, m.name), m.per_device ? " (per-device: not in shared configs)" : "", ` – ${m.description ?? ""}`)));
  $("add-method").replaceChildren(...B.callableMethods(ui.methods).map(m => h("option", { value: m.name }, m.name)));
  ui.loadedVersion = key;
  ui.loadedConfig = null;
  await renderConfigs();
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
  if (sel.value !== ui.loadedConfig) loadConfig(); // else keep the editor, including unsaved edits
}

function selectedConfig() {
  const id = $("config").value;
  if (id === DEFAULT) return { id: null, name: DEFAULT, script: { calls: ui.defaultScript.calls } };
  return ui.configs.find(c => c.id === id);
}

function loadConfig() {
  const c = selectedConfig();
  ui.loadedConfig = $("config").value;
  ui.script = { calls: structuredClone(c.script.calls) };
  ui.dirty = false;
  ui.jsonError = null;
  $("archive-config").classList.toggle("hidden", c.id === null);
  $("editor").value = pretty(ui.script);
  renderBuilder();
  validate();
}

/** Apply a builder edit: update the script, the JSON view and the validation; re-render the form if structure changed. */
function edit(next, structural = false) {
  ui.script = next;
  ui.dirty = true;
  $("editor").value = pretty(next);
  if (structural) renderBuilder();
  validate();
}

function validate() {
  const errors = ui.jsonError ? [`not valid JSON: ${ui.jsonError}`] : validateScript(ui.script, ui.methods, true);
  $("editor").classList.toggle("invalid", errors.length > 0);
  const n = Array.isArray(ui.script?.calls) ? ui.script.calls.length : 0;
  $("validation").replaceChildren(errors.length
    ? h("ul", { class: "errors" }, errors.map(e => h("li", {}, e)))
    : h("div", { class: "valid" }, `✓ valid · ${n} call${n === 1 ? "" : "s"}${ui.dirty ? " · unsaved changes" : ""}`));
  $("save-config").disabled = errors.length > 0;
  $("save-profile").disabled = errors.length > 0;
  return errors.length === 0;
}

// ---- Form | JSON ----

function setMode(mode) {
  if (mode === "form" && ui.jsonError) { alert("Fix the JSON first; the form needs a valid script to show."); return; }
  ui.mode = mode;
  $("mode-form").classList.toggle("active", mode === "form");
  $("mode-json").classList.toggle("active", mode === "json");
  for (const id of ["builder", "builder-add"]) $(id).classList.toggle("hidden", mode !== "form");
  $("editor").classList.toggle("hidden", mode !== "json");
  if (mode === "form") renderBuilder();
}
$("mode-form").addEventListener("click", () => setMode("form"));
$("mode-json").addEventListener("click", () => setMode("json"));

$("editor").addEventListener("input", () => {
  ui.dirty = true;
  try {
    const parsed = JSON.parse($("editor").value);
    ui.jsonError = null;
    ui.script = parsed ?? {}; // the validator reports anything that isn't a script
  } catch (e) {
    ui.jsonError = e.message;
  }
  validate();
});

// ---- the form ----

function renderBuilder() {
  if (ui.mode !== "form" || !ui.methods) return;
  const calls = Array.isArray(ui.script?.calls) ? ui.script.calls : [];
  const callable = B.callableMethods(ui.methods);
  $("builder").replaceChildren(...calls.map((call, i) => {
    const known = callable.some(m => m.name === call.method);
    const head = h("div", { class: "call-head" },
      h("span", { class: "n" }, `${i + 1}.`),
      h("select", { onchange: e => edit(B.replaceCall(ui.script, i, B.newCall(ui.methods, e.target.value)), true) },
        known ? null : h("option", { value: call.method, selected: true, disabled: true }, `${call.method} (not allowed)`),
        callable.map(m => h("option", { value: m.name, selected: m.name === call.method }, m.name))),
      h("button", { class: "secondary icon", title: "move up", disabled: i === 0, onclick: () => edit(B.moveCall(ui.script, i, -1), true) }, "↑"),
      h("button", { class: "secondary icon", title: "move down", disabled: i === calls.length - 1, onclick: () => edit(B.moveCall(ui.script, i, 1), true) }, "↓"),
      h("button", { class: "danger icon", title: "remove", onclick: () => edit(B.removeCall(ui.script, i), true) }, "✕"));
    const m = ui.methods.methods[call.method];
    let body;
    if (!B.representable(call, ui.methods)) body = h("div", { class: "muted fld" }, "This call has something the form can't show; edit it in JSON.");
    else if (m?.params) body = renderFields(B.fieldsFor(m.params, call.params ?? {}), i);
    else body = h("div", { class: "muted fld" }, m?.description ?? "No settings.");
    return h("div", { class: "call" }, head, m?.description && m.params ? h("div", { class: "muted" }, m.description) : null, body);
  }), calls.length ? "" : h("div", { class: "muted", style: "margin-top:10px" }, "No calls yet: add one below."));
}

function renderFields(fields, i, parentIncluded = true) {
  return fields.map(f => {
    const on = f.required || f.included;
    const toggle = f.required ? null : h("input", {
      type: "checkbox", checked: f.included, title: "include this setting",
      onchange: e => edit(e.target.checked ? B.setParam(ui.script, i, f.path, f.value) : B.unsetParam(ui.script, i, f.path), true),
    });
    const set = (v) => edit(B.setParam(ui.script, i, f.path, v));
    if (f.kind === "object") {
      return h("div", { class: `fld${on && parentIncluded ? "" : " off"}` },
        h("div", { class: "fld-head" }, toggle, h("label", {}, f.label), h("span", { class: "muted" }, f.description)),
        h("fieldset", {}, renderFields(f.children, i, on && parentIncluded)));
    }
    let ctl;
    const num = v => (f.schema.type === "integer" ? Math.round(Number(v)) : Number(v));
    if (f.kind === "range") {
      const range = h("input", { type: "range", min: f.schema.minimum, max: f.schema.maximum, step: B.stepFor(f.schema), value: f.value });
      const box = h("input", { type: "number", min: f.schema.minimum, max: f.schema.maximum, step: f.schema.type === "integer" ? 1 : "any", value: f.value });
      range.addEventListener("input", () => { box.value = range.value; set(num(range.value)); });
      box.addEventListener("input", () => { if (box.value !== "") { range.value = box.value; set(num(box.value)); } });
      ctl = [range, box];
    } else if (f.kind === "number") {
      ctl = h("input", { type: "number", value: f.value, oninput: e => e.target.value !== "" && set(num(e.target.value)) });
    } else if (f.kind === "enum") {
      ctl = h("select", { onchange: e => set(e.target.value) }, f.schema.enum.map(x => h("option", { value: x, selected: x === f.value }, x)));
    } else if (f.kind === "bool") {
      ctl = h("input", { type: "checkbox", checked: f.value, onchange: e => set(e.target.checked) });
    } else {
      ctl = h("input", { type: "text", value: f.value ?? "", oninput: e => set(e.target.value) });
    }
    const unit = f.key.endsWith("_ms") ? "ms" : f.key.endsWith("_hz") ? "Hz" : f.key === "seconds" ? "s" : "";
    return h("div", { class: `fld${on && parentIncluded ? "" : " off"}` },
      h("div", { class: "fld-head" }, toggle, h("label", { title: f.description }, f.label),
        f.kind === "range" ? h("span", { class: "muted" }, `${f.schema.minimum}–${f.schema.maximum}${unit ? " " + unit : ""}`) : null),
      h("div", { class: "fld-ctl" }, ctl, unit && f.kind !== "range" ? h("span", { class: "muted" }, unit) : null));
  });
}

$("add-call").addEventListener("click", () => {
  const base = Array.isArray(ui.script?.calls) ? ui.script : { calls: [] };
  edit(B.addCall(base, B.newCall(ui.methods, $("add-method").value)), true);
});

$("app").addEventListener("change", renderVersions);
$("version").addEventListener("change", renderVersion);
$("config").addEventListener("change", loadConfig);

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
  if (!validate()) return null;
  const name = prompt("Name for this config:", ui.dirty ? "" : `${selectedConfig().name}-copy`)?.trim();
  if (!name) return null;
  const rec = await addRecord(store, "configs", {
    id: crypto.randomUUID(), app: $("app").value, version: $("version").value, name, script: { calls: ui.script.calls },
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
  const rf = ui.methods.rf_stacks ? $("rf-stack").value : null;
  const name = prompt("Name for this profile:", `${cfg.name} @ ${version}${rf ? ` · RF ${rf}` : ""}`)?.trim();
  if (!name) return;
  const p = await addRecord(store, "profiles", {
    id: crypto.randomUUID(), name, app: $("app").value, version, config_id: cfg.id, config_name: cfg.name,
    script: { calls: cfg.script.calls }, rf_stack: rf, created_at: new Date().toISOString(), client: CLIENT,
  });
  catalogue.keepOffline($("app").value, version).catch(() => {});
  await store.setMeta("deployProfile", p.id);
  sync.refreshPending();
  await renderProfiles();
  syncNow();
  showTab("deploy");
});

$("archive-config").addEventListener("click", async () => {
  const c = selectedConfig();
  if (!c.id || !confirm(`Archive config "${c.name}"? It's hidden from the list but kept in history.`)) return;
  await addRecord(store, "archives", { id: crypto.randomUUID(), kind: "config", record_id: c.id, archived_at: new Date().toISOString(), client: CLIENT });
  await renderConfigs(DEFAULT);
  syncNow();
});

// ============================== Deploy ==============================

// Renders can overlap (a save and a background sync both re-render). Each render does its
// async reads first and only touches the DOM if no newer render has started since.
let profilesGen = 0;

async function renderProfiles() {
  const gen = ++profilesGen;
  const archived = await archivedIds(store, "profile");
  const profiles = (await store.all("profiles")).filter(p => !archived.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sel = $("profile-select");
  const want = (await store.getMeta("deployProfile")) ?? sel.value;
  if (gen !== profilesGen) return;
  ui.profiles = profiles;
  sel.replaceChildren(...(ui.profiles.length
    ? ui.profiles.map(p => h("option", { value: p.id }, p.name))
    : [h("option", { value: "" }, "no profiles yet: make one in Build")]));
  if (ui.profiles.some(p => p.id === want)) sel.value = want;
  await renderProfileDetail();
}

async function renderProfileDetail() {
  const gen = ++profilesGen;
  const p = ui.profiles.find(x => x.id === $("profile-select").value);
  $("deploy-btn").disabled = !p || !navigator.bluetooth;
  if (!p) { $("profile-detail").replaceChildren(); renderTarget(); return; }
  const offline = await catalogue.isOffline(p.app, p.version);
  if (gen !== profilesGen) return; // a newer render (or another selection) owns the card now
  $("profile-detail").replaceChildren(h("div", { class: "detail" },
    h("div", {}, h("b", {}, p.name),
      offline ? h("span", { class: "badge ok" }, "offline ✓") : h("span", { class: "badge warn" }, "needs network"),
      p._rejected ? h("span", { class: "badge bad" }, "refused by server") : null),
    h("dl", { class: "kv", style: "margin-top:8px" },
      h("dt", {}, "firmware"), h("dd", {}, `${p.app} ${p.version}`),
      h("dt", {}, "radio stack"), h("dd", {}, p.rf_stack ?? "–"),
      h("dt", {}, "config"), h("dd", {}, p.config_name),
      h("dt", {}, "created"), h("dd", {}, new Date(p.created_at).toLocaleString())),
    h("div", { class: "muted", style: "margin-top:8px" }, "Calls, run in order:"),
    h("ol", {}, p.script.calls.map(c => h("li", {}, h("code", {}, c.method), " ", h("span", { class: "muted mono" }, compact(c.params))))),
    h("div", { class: "row" }, h("button", { class: "danger small", onclick: () => archiveProfile(p) }, "Archive profile"))));
  renderTarget();
}
$("profile-select").addEventListener("change", async () => {
  await store.setMeta("deployProfile", $("profile-select").value);
  renderProfileDetail();
});

function renderTarget() {
  const t = ui.target;
  $("target-line").replaceChildren(t
    ? h("span", {}, "Target: ", h("b", {}, t.name), t.device_id ? h("span", { class: "muted mono" }, ` · ${t.device_id}`) : null,
        h("span", { class: "muted" }, " (only this node will be offered)"))
    : h("span", { class: "muted" }, "Target: any hs-* node; you'll pick it in the Bluetooth chooser."),
    t ? h("button", { class: "secondary icon", title: "clear target", onclick: () => { ui.target = null; renderTarget(); } }, "✕") : null);
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
$("deploy-btn").addEventListener("click", async () => {
  const profile = ui.profiles.find(x => x.id === $("profile-select").value);
  if (deploying || !profile) return;
  let node;
  try {
    // first: needs the tap's user activation. A fleet target narrows the chooser to that node.
    node = await Node.choose(ui.target ? [{ name: ui.target.name }] : undefined);
  } catch (e) {
    if (e.name !== "NotFoundError") alert(`Couldn't connect: ${e.message}`);
    return;
  }
  deploying = true;
  $("deploy-btn").disabled = true;
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
    if (ui.target?.device_id && rec.device_id && rec.device_id !== ui.target.device_id) {
      r.textContent += ` ⚠ this was device ${rec.device_id}, not the targeted ${ui.target.device_id}`;
    }
  } finally {
    lock?.release();
    node.disconnect();
    deploying = false;
    $("deploy-btn").disabled = false;
    sync.refreshPending();
    syncNow();
  }
});

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
      out.push(["device ID", info.device_id], ["BLE address", info.ble_address ?? "–"], ["firmware", `${info.app} ${info.version}`],
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

// ============================== Fleet ==============================

async function refreshMetrics() {
  try {
    const r = await fetch("api/fleet/metrics?hours=24");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ui.metrics = { at: new Date().toISOString(), rows: await r.json() };
    await store.setMeta("metrics", ui.metrics);
  } catch { /* offline: keep the cached copy */ }
  if (fleetVisible()) renderFleet();
}
setInterval(() => fleetVisible() && refreshMetrics(), 30000);

function targetDevice(name, device_id = null, ble_address = null) {
  ui.target = { name, device_id, ble_address };
  showTab("deploy");
  renderTarget();
}

function metricsLine(m, extra = []) {
  if (!m) return h("span", {}, "not heard by the scanner in 24 h", ...extra);
  const cap = m.capture_pct == null ? "–" : `${m.capture_pct}%`;
  return h("span", {}, `seen ${ago(m.last_seen)} · ${m.rssi_last ?? "–"} dBm · capture ${cap} · missed ${m.missed}`, ...extra);
}

let fleetGen = 0;

async function renderFleet() {
  const gen = ++fleetGen;
  const view = buildFleetView(await fleet(store), ui.metrics?.rows ?? [], await store.all("profiles"));
  if (gen !== fleetGen) return;
  $("metrics-age").textContent = ui.metrics
    ? (sync.state.online === false ? `network metrics as of ${new Date(ui.metrics.at).toLocaleTimeString()}` : `metrics ${ago(ui.metrics.at)}`)
    : "no network metrics yet";
  if (!view.groups.length) {
    $("fleet-groups").replaceChildren(h("div", { class: "muted", style: "margin-top:12px" }, "No deployments recorded yet."));
  } else {
    $("fleet-groups").replaceChildren(...view.groups.map(g => h("div", { class: "group" },
      h("div", { class: "group-head" }, h("h3", {}, g.name),
        h("span", { class: "muted" }, `${g.app} ${g.version}`),
        g.rf_stack ? h("span", { class: "badge accent" }, `RF ${g.rf_stack}`) : null,
        g.config_name ? h("span", { class: "badge" }, `config ${g.config_name}`) : null,
        h("span", { class: "muted" }, `· ${g.devices.length} device${g.devices.length === 1 ? "" : "s"}`)),
      g.devices.map(d => deviceRow(d)))));
  }
  $("unprovisioned").replaceChildren(...(view.unprovisioned.length ? [h("div", { class: "group" },
    h("div", { class: "group-head" }, h("h3", {}, "Seen by the scanner, not in the fleet"),
      h("span", { class: "muted" }, "no deployment recorded yet")),
    view.unprovisioned.map(m => h("div", { class: "dev" },
      h("div", { class: "dev-row", style: "cursor:default" },
        h("span", { class: `dot ${seenState(m.last_seen)}` }),
        h("span", {}, h("b", {}, boardName(m.board_id)), h("span", { class: "muted mono" }, ` · ${m.address}`)),
        h("button", { class: "secondary small", onclick: () => targetDevice(boardName(m.board_id), null, m.address) }, "Deploy to it"),
        h("span", { class: "metrics" }, metricsLine(m))))))] : []));
}

function deviceRow(d) {
  const open = ui.expanded.has(d.device_id);
  const name = d.board_id != null ? boardName(d.board_id) : "hs-??";
  const m = d.metrics;
  const toggle = () => { open ? ui.expanded.delete(d.device_id) : ui.expanded.add(d.device_id); renderFleet(); };
  const row = h("div", { class: "dev-row", onclick: toggle, title: open ? "collapse" : "expand" },
    h("span", { class: `dot ${seenState(m?.last_seen)}` }),
    h("span", {}, h("b", {}, name), h("span", { class: "muted mono" }, ` · ${d.device_id}`)),
    h("span", {}, d.latest.ok ? h("span", { class: "badge ok" }, "ok") : h("span", { class: "badge bad" }, "last deploy failed"),
      h("span", { class: "chev" }, " ›")),
    h("span", { class: "metrics" }, metricsLine(m, [` · ${d.current.version}`])));
  if (!open) return h("div", { class: "dev" }, row);
  const kv = [
    ["device ID", d.device_id], ["BLE address", d.ble_address], ["firmware", `${d.current.app} ${d.current.version}`],
    ["profile", d.current.profile_name ?? "–"], ["radio stack", d.current.rf_stack ?? "–"],
    ["last deploy", `${new Date(d.latest.finished_at).toLocaleString()} ${d.latest.ok ? "✓" : `✗ ${d.latest.error ?? ""}`}`],
  ];
  if (m) kv.push(["last seen", `${new Date(m.last_seen).toLocaleString()} (${ago(m.last_seen)})`],
                 ["RSSI", `${m.rssi_last} dBm now · ${m.rssi_avg_1h ?? "–"} dBm 1 h avg`],
                 ["capture (24 h)", `${m.capture_pct}% · ${m.readings} readings, ${m.missed} missed, ${m.resets} reboots`],
                 ["node", `uptime ${m.uptime_s} s · ${m.temp_c} °C`]);
  return h("div", { class: "dev open" }, row, h("div", { class: "dev-body" },
    h("dl", { class: "kv" }, kv.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    h("div", { class: "row" },
      h("button", { class: "small", onclick: () => targetDevice(name, d.device_id, d.ble_address) }, "Deploy to this device"),
      h("button", { class: "secondary small", onclick: toggle }, "Collapse")),
    h("div", { class: "muted", style: "margin-top:10px" }, `History (${d.history.length})`),
    d.history.map(x => h("div", { class: "hist" },
      h("div", {}, h("b", {}, x.profile_name ?? "–"),
        x.ok ? h("span", { class: "badge ok" }, "ok") : h("span", { class: "badge bad" }, "failed"),
        x.flashed ? h("span", { class: "badge" }, `flashed ${x.from_version} → ${x.version}`) : null,
        x.rf_stack ? h("span", { class: "badge accent" }, `RF ${x.rf_stack}`) : null),
      h("div", { class: "muted" }, `${new Date(x.finished_at).toLocaleString()} · board ${x.board_id ?? "–"} · ${x.results.length} call(s)${x.error ? ` · ${x.error}` : ""}`)))));
}

// ============================== Alerts ==============================
// One fleet-wide threshold lives on the server (it sends the alerts); this phone subscribes
// to Web Push so alerts arrive with the app closed. Tapping one opens the dashboard (sw.js).

let alertsCfg = (await store.getMeta("alerts")) ?? null;

const b64ToBytes = s => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};

async function pushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function loadAlerts() {
  try {
    const r = await fetch("api/alerts/config");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    alertsCfg = await r.json();
    await store.setMeta("alerts", alertsCfg);
  } catch { /* offline: keep the cached copy */ }
  await renderAlerts();
}

async function renderAlerts() {
  const c = alertsCfg;
  const online = sync.state.online !== false;
  const sub = await pushSubscription().catch(() => null);
  $("alerts-on").checked = Boolean(sub) && typeof Notification !== "undefined" && Notification.permission === "granted";
  $("bell").textContent = $("alerts-on").checked ? "🔔" : "🔕";
  if (c) {
    if (document.activeElement !== $("threshold")) $("threshold").value = c.threshold_c;
    if (document.activeElement !== $("threshold-range")) $("threshold-range").value = c.threshold_c;
    if (document.activeElement !== $("clear-below")) $("clear-below").value = c.clear_below_c;
    $("threshold-info").textContent = `Currently ${c.threshold_c} °C, back to normal below ${c.clear_below_c} °C` +
      (c.changed_at ? ` · set ${ago(c.changed_at)}` : " · default") + (online ? "" : " · offline: shown read-only");
  }
  const perm = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  $("alerts-status").textContent =
    perm === "denied" ? "Notifications are blocked for this site: allow them in Chrome's site settings." :
    c && !c.push_enabled ? "The server has no push keys configured, so alerts can't be sent." :
    $("alerts-on").checked ? "This phone will be notified." : "Off for this phone.";
  for (const id of ["threshold", "threshold-range", "clear-below", "threshold-save"]) $(id).disabled = !online || !c;
  $("alerts-test").disabled = !online || !$("alerts-on").checked;
  $("alerts-on").disabled = !online || !c?.push_enabled;
}

$("bell").addEventListener("click", () => { $("alerts-card").classList.toggle("hidden"); loadAlerts(); });
$("alerts-close").addEventListener("click", () => $("alerts-card").classList.add("hidden"));
$("threshold-range").addEventListener("input", e => { $("threshold").value = e.target.value; });
$("threshold").addEventListener("input", e => { $("threshold-range").value = e.target.value; });

$("alerts-on").addEventListener("change", async e => {
  try {
    if (e.target.checked) {
      if ((await Notification.requestPermission()) !== "granted") throw new Error("notification permission not given");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ??
        await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(alertsCfg.vapid_public_key) });
      const r = await fetch("api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...sub.toJSON(), client: CLIENT }) });
      if (!r.ok) throw new Error((await r.json()).detail ?? `HTTP ${r.status}`);
    } else {
      const sub = await pushSubscription();
      if (sub) {
        await fetch("api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
        await sub.unsubscribe();
      }
    }
  } catch (err) {
    alert(`Couldn't change alerts: ${err.message}`);
  }
  renderAlerts();
});

$("threshold-save").addEventListener("click", async () => {
  const threshold_c = Number($("threshold").value), clear_below_c = Number($("clear-below").value);
  if (!(clear_below_c < threshold_c)) { alert("'Back to normal below' must be lower than the alert threshold."); return; }
  try {
    const r = await fetch("api/alerts/config", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold_c, clear_below_c, client: CLIENT }) });
    const body = await r.json();
    if (!r.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
    alertsCfg = body;
    await store.setMeta("alerts", alertsCfg);
  } catch (err) {
    alert(`Couldn't save the threshold: ${err.message}`);
  }
  renderAlerts();
});

$("alerts-test").addEventListener("click", async () => {
  try {
    const r = await (await fetch("api/push/test", { method: "POST" })).json();
    $("alerts-status").textContent = r.sent
      ? `Test alert sent to ${r.sent} phone${r.sent === 1 ? "" : "s"}. Close the app to see it arrive.`
      : "No phone received it: check that alerts are on.";
  } catch (err) {
    $("alerts-status").textContent = `Test failed: ${err.message}`;
  }
});

// ============================== Gateway ==============================

function gwLog(msg) {
  $("gw-log").textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  $("gw-log").scrollTop = $("gw-log").scrollHeight;
}

async function renderGateway() {
  gwPending = await store.count("gateway");
  renderStatus();
  $("gw-pending").textContent = gwPending
    ? `${gwPending} reading${gwPending === 1 ? "" : "s"} waiting to upload`
    : "Nothing waiting to upload.";
  $("gw-upload").disabled = !gwPending;
  const devices = [];
  for (const f of await fleet(store)) {
    const c = await store.getMeta(`gw:${f.device_id}`);
    if (c) devices.push([f.device_id, c]);
  }
  $("gw-devices").replaceChildren(...(devices.length ? [h("div", { class: "muted", style: "margin-top:10px" }, "Last collected:"),
    ...devices.map(([id, c]) => h("div", { class: "hist" },
      h("b", {}, c.name), h("span", { class: "muted mono" }, ` · ${id}`),
      h("div", { class: "muted" }, `${ago(c.last_collect)} · ${c.collected} reading(s) that time`)))] : []));
}

$("gw-collect").addEventListener("click", async () => {
  let node;
  try { node = await Node.choose(); } catch (e) { if (e.name !== "NotFoundError") alert(e.message); return; }
  const res = $("gw-result");
  try {
    const r = await GW.collect(node, store, { log: gwLog });
    res.className = "result show ok";
    res.textContent = `✓ ${r.collected} new reading${r.collected === 1 ? "" : "s"} from ${node.device.name}` +
      (sync.state.online === false ? " · kept on the phone until you're back online" : "");
  } catch (e) {
    res.className = "result show bad";
    res.textContent = `✗ ${e.message}`;
    gwLog(`FAILED: ${e.message}`);
  } finally {
    node.disconnect();
  }
  await renderGateway();
  syncNow();
});

$("gw-upload").addEventListener("click", syncNow);

// ============================== go ==============================

async function refreshAll() {
  await renderApps();
  await renderProfiles();
  if (fleetVisible()) await renderFleet();
}

setMode("form");
await sync.refreshPending();
await refreshAll();
await renderGateway();
renderAlerts();
syncNow();
