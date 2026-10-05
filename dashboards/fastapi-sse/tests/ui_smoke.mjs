// UI smoke test: loads the real static/app.js in jsdom (fake IndexedDB, fake server,
// in-memory Cache Storage) and drives Build -> Deploy -> Fleet like a user would.
// No Web Bluetooth here, so the BLE steps themselves are covered by test_provision.mjs.
//   cd dashboards/fastapi-sse && npm install && node tests/ui_smoke.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
const { validateScript: validateScriptFor } = await import(new URL("../static/schema.js", import.meta.url).href);

const here = new URL("..", import.meta.url);
const repo = new URL("../../", here);
const methods = JSON.parse(readFileSync(new URL("firmware/apps/hs_advertiser/methods.json", repo)));
const defaults = JSON.parse(readFileSync(new URL("firmware/apps/hs_advertiser/default.json", repo)));
const sbMethods = JSON.parse(readFileSync(new URL("firmware/apps/single-blink/methods.json", repo)));
const sbDefaults = JSON.parse(readFileSync(new URL("firmware/apps/single-blink/default.json", repo)));
const BASE = "https://lenovo.test/admin";
const VER = "v1.3.0-test";

// ---------- page ----------
const html = readFileSync(new URL("static/provision.html", here), "utf8").replace(/<script[^>]*app\.js[^>]*><\/script>/, "");
const dom = new JSDOM(html, { url: BASE, pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "HTMLElement", "Node", "Event", "localStorage"]) globalThis[k] = window[k];
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.window = window;
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
const alerts = [];
window.alert = globalThis.alert = m => alerts.push(m);
let promptAnswers = [];
const promptDefaults = [];
window.prompt = globalThis.prompt = (msg, def) => { promptDefaults.push(def); return promptAnswers.shift() ?? null; };
window.confirm = globalThis.confirm = () => true;

// ---------- fake server ----------
const t0 = Date.now();
const iso = s => new Date(t0 - s * 1000).toISOString();
const serverDeployments = [
  { id: crypto.randomUUID(), device_id: "58e6c513033c", board_id: 1, profile_id: "p-fast", profile_name: "fast-blink", app: "hs_advertiser",
    version: VER, from_version: VER, flashed: false, rf_stack: "v1", ble_address: null, script: { calls: [] }, results: [], ok: true, error: null,
    started_at: iso(400), finished_at: iso(400), client: "test", seq: 1 },
  { id: crypto.randomUUID(), device_id: "58e6c5195088", board_id: 2, profile_id: "p-fast", profile_name: "fast-blink", app: "hs_advertiser",
    version: VER, from_version: "v1.2.0", flashed: true, rf_stack: "v1", ble_address: "58:E6:C5:19:50:8A", script: { calls: [] }, results: [], ok: true,
    error: null, started_at: iso(200), finished_at: iso(200), client: "test", seq: 2 },
];
const serverProfiles = [{ id: "p-fast", name: "fast-blink", app: "hs_advertiser", version: VER, config_id: null, config_name: "default",
  script: { calls: defaults.calls }, rf_stack: "v1", created_at: iso(500), client: "test", seq: 3 }];
const pushed = [];
let alertCfg = { threshold_c: 35, clear_below_c: 34, changed_at: null, vapid_public_key: "BAAA", push_enabled: true };
const savedThresholds = [];
const gatewayUploads = [];
const metrics = [
  { address: "58:E6:C5:13:03:3E", board_id: 1, last_seen: iso(2), rssi_last: -57, rssi_avg_1h: -56, readings: 17000, missed: 40, resets: 3, capture_pct: 99.77, uptime_s: 900, temp_c: 30 },
  { address: "58:E6:C5:19:50:8A", board_id: 2, last_seen: iso(1), rssi_last: -51, rssi_avg_1h: -52, readings: 700, missed: 0, resets: 1, capture_pct: 100, uptime_s: 300, temp_c: 31 },
  { address: "11:22:33:44:55:66", board_id: 9, last_seen: iso(30), rssi_last: -80, rssi_avg_1h: -79, readings: 10, missed: 5, resets: 0, capture_pct: 66.67, uptime_s: 50, temp_c: 29 },
];
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, BASE);
  const p = url.pathname;
  if (p === "/api/apps") return json([
    { app: "hs_advertiser", versions: [{ version: VER, configurable: true, size: 680000, built: "2026-10-05T10:00:00", idf: "v6.1", sha256: "x" }] },
    { app: "single-blink", versions: [{ version: VER, configurable: true, size: 680000, built: "2026-10-05T10:00:00", idf: "v6.1", sha256: "y" }] }]);
  if (p === `/api/apps/single-blink/${VER}/methods.json`) return json(sbMethods);
  if (p === `/api/apps/single-blink/${VER}/default.config.json`) return json(sbDefaults);
  if (p === `/api/apps/hs_advertiser/${VER}/methods.json`) return json(methods);
  if (p === `/api/apps/hs_advertiser/${VER}/default.config.json`) return json(defaults);
  if (p === `/api/apps/hs_advertiser/${VER}/firmware.bin`) return new Response(new Uint8Array(16));
  if (p === "/api/sync" && init.method === "POST") {
    const body = JSON.parse(init.body);
    pushed.push(body);
    return json({ accepted: Object.fromEntries(Object.entries(body).map(([t, rs]) => [t, rs.map(r => r.id)])), rejected: [] });
  }
  if (p === "/api/sync") return json({ seq: 3, configs: [], profiles: serverProfiles, deployments: serverDeployments, archives: [] });
  if (p === "/api/fleet/metrics") return json(metrics);
  if (p === "/api/alerts/config" && init.method === "POST") {
    const b = JSON.parse(init.body);
    if (!(b.clear_below_c < b.threshold_c)) return json({ detail: "bad" }, 422);
    alertCfg = { ...alertCfg, threshold_c: b.threshold_c, clear_below_c: b.clear_below_c, changed_at: new Date().toISOString() };
    savedThresholds.push(b.threshold_c);
    return json(alertCfg);
  }
  if (p === "/api/alerts/config") return json(alertCfg);
  if (p === "/api/gateway/readings") {
    const b = JSON.parse(init.body);
    gatewayUploads.push(b.readings.length);
    return json({ inserted: b.readings.length, duplicates: 0 });
  }
  return json({ detail: "not found" }, 404);
};
const cacheStore = new Map();
globalThis.caches = window.caches = {
  async open(name) {
    if (!cacheStore.has(name)) cacheStore.set(name, new Map());
    const m = cacheStore.get(name);
    const key = k => new URL(typeof k === "string" ? k : k.url, BASE).href;
    return { async match(k) { return m.get(key(k))?.clone(); }, async put(k, r) { m.set(key(k), r.clone()); } };
  },
};

// ---------- helpers ----------
const $ = id => window.document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(20); }
  throw new Error(`timed out waiting for ${what}`);
}
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
const click = el => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const editorScript = () => JSON.parse($("editor").value);
const tab = name => click(window.document.querySelector(`nav.tabs button[data-tab="${name}"]`));
let passed = 0;
const ok = m => { passed++; console.log(`ok  ${m}`); };

// ---------- run the app ----------
await import(new URL("static/app.js", here).href);
await waitFor(() => $("profile-select").options.length && $("profile-select").value === "p-fast", "initial sync of profiles");
ok("app boots, syncs from the server, Deploy shows the synced profile");

assert.equal(window.document.querySelector("h1").textContent, "⚙️ Admin");
assert.deepEqual([...window.document.querySelectorAll("nav.tabs button")].map(b => b.textContent), ["Fleet", "Profile", "Deploy", "Gateway"]);
assert.ok(!window.document.querySelector('[data-panel="fleet"]').classList.contains("hidden"), "opens on Fleet");
ok("Admin: title, tab order Fleet / Profile / Deploy / Gateway, opens on Fleet");

assert.ok($("unsupported").classList.contains("show"), "no Web Bluetooth -> explained, deploy disabled");
assert.equal($("deploy-btn").disabled, true);
assert.doesNotMatch($("profile-detail").textContent, /radio stack/, "details collapsed by default");
const viewBtn = () => [...$("profile-detail").querySelectorAll("button")].find(b => /profile/.test(b.textContent));
assert.equal(viewBtn().textContent, "View profile");
click(viewBtn());
await waitFor(() => /radio stack.*v1/s.test($("profile-detail").textContent), "profile expanded");
assert.match($("profile-detail").textContent, /config\.set/);
assert.ok([...$("profile-detail").querySelectorAll("button")].some(b => b.textContent === "Export JSON"));
click(viewBtn());
await waitFor(() => !/radio stack/.test($("profile-detail").textContent), "profile collapsed again");
click(viewBtn());
await waitFor(() => /radio stack/.test($("profile-detail").textContent), "expanded for later checks");
ok("Deploy: profile dropdown; 'View profile' expands the details (firmware, radio stack, calls, export) and hides them");

// ---------- Build with the form ----------
tab("profile");
await waitFor(() => $("builder").querySelector(".call"), "builder render");
assert.deepEqual([...$("rf-stack").options].map(o => o.value), ["v1", "v2"]);
assert.equal($("rf-stack").value, "v1", "preset to the firmware's default stack");
assert.deepEqual(editorScript().calls, defaults.calls, "starts from the version's default config");

const field = label => [...$("builder").querySelectorAll(".fld")].find(f => f.querySelector(".fld-head label")?.textContent === label);
const range = field("blink hz").querySelector('input[type=range]');
range.value = "4"; fire(range, "input");
assert.equal(editorScript().calls[0].params.led.blink_hz, 4, "slider writes the script");
assert.equal(field("blink hz").querySelector('input[type=number]').value, "4", "number box follows the slider");
const mode = field("mode").querySelector("select");
mode.value = "heartbeat"; fire(mode, "change");
assert.equal(editorScript().calls[0].params.led.mode, "heartbeat");
const incl = field("adv interval ms").querySelector('.fld-head input[type=checkbox]');
incl.checked = false; fire(incl, "change");
await waitFor(() => !("adv_interval_ms" in editorScript().calls[0].params), "unset adv_interval_ms");
assert.ok(field("adv interval ms").classList.contains("off"), "excluded field shown greyed");
ok("Form: slider + number box, enum dropdown, include toggle all edit the script");

$("add-method").value = "device.identify";
click($("add-call"));
await waitFor(() => $("builder").querySelectorAll(".call").length === 2, "second call");
const cards = () => [...$("builder").querySelectorAll(".call")];
click(cards()[1].querySelector('button[title="move up"]'));
await waitFor(() => editorScript().calls[0].method === "device.identify", "reorder");
assert.deepEqual(editorScript().calls.map(c => c.method), ["device.identify", "config.set"]);
assert.match($("validation").textContent, /✓ valid · 2 calls · unsaved changes/);
ok("Form: add call and move it up; live validation stays green");

// methods guide is descriptive
const ref = $("methods-ref").textContent;
assert.match(ref, /A config is a list of these calls, run in order on the node/);
assert.match(ref, /update_interval_ms \(whole number 1000–600000 ms, default 5000 ms\)/);
assert.match(ref, /How often the node takes a new reading/);
assert.match(ref, /device\.reboot.*reboots the node.*Takes no parameters/s);
ok("Methods guide: what each call does, every setting's type, range, unit, default and meaning");

// ---------- JSON fallback ----------
click($("mode-json"));
assert.ok(!$("editor").classList.contains("hidden") && $("builder").classList.contains("hidden"));
$("editor").value = '{"calls": [{"method": "config.set", "params": {"led": {"blink_hz": 99}}}]}'; fire($("editor"), "input");
assert.match($("validation").textContent, /led\.blink_hz: must be at most 10/);
assert.equal($("save-config").disabled, true);
$("editor").value = "{ not json"; fire($("editor"), "input");
assert.match($("validation").textContent, /not valid JSON/);
click($("mode-form"));
assert.ok(alerts.some(a => /Fix the JSON first/.test(a)), "can't switch to the form with broken JSON");
const good = { calls: [{ method: "device.identify", params: { seconds: 10 } }, { method: "config.set", params: { led: { mode: "heartbeat", blink_hz: 4 }, update_interval_ms: 5000 } }] };
$("editor").value = JSON.stringify(good); fire($("editor"), "input");
click($("mode-form"));
await waitFor(() => cards().length === 2 && !$("builder").classList.contains("hidden"), "form re-rendered from JSON");
ok("JSON: errors shown, form blocked while broken, form rebuilt from valid JSON");

// ---------- a background sync must not wipe work in progress ----------
$("rf-stack").value = "v2";
const before = $("editor").value;
click($("sync-now"));
await sleep(400); // let the sync and its re-render run
assert.equal($("rf-stack").value, "v2", "radio stack choice survives a background refresh");
assert.equal($("editor").value, before, "unsaved edits survive a background refresh");
assert.match($("validation").textContent, /unsaved changes/);
ok("Background sync keeps the radio stack choice and unsaved edits (regression)");

// ---------- save config + profile (radio stack v2) ----------
promptAnswers = ["heartbeat-4hz"];
click($("save-config"));
await waitFor(async () => [...$("config").options].some(o => o.textContent === "heartbeat-4hz"), "saved config listed");
promptAnswers = ["beacon RF2"];
click($("save-profile"));
await waitFor(() => [...$("profile-select").options].some(o => o.textContent === "beacon RF2"), "saved profile listed");
await waitFor(() => $("profile-select").options[$("profile-select").selectedIndex]?.textContent === "beacon RF2", "new profile selected in Deploy");
await waitFor(() => /beacon RF2.*radio stack\s*v2/s.test($("profile-detail").textContent), "detail card for the new profile");
await waitFor(() => pushed.some(b => b.profiles?.some(p => p.name === "beacon RF2" && p.rf_stack === "v2")), "profile pushed with rf_stack");
const sentProfile = pushed.flatMap(b => b.profiles).find(p => p.name === "beacon RF2");
assert.deepEqual(sentProfile.script, good, "profile carries the built script");
assert.match(promptDefaults.at(-1), /^heartbeat-4hz @ hs_advertiser v1\.3\.0-test · RF v2$/, "suggested profile name includes the firmware app");
ok("Save config as + Save as profile: radio stack v2 stored and synced, Deploy switches to it; name suggests app + version");

// ---------- files: load a config script; import a whole profile ----------
const loadFile = async (name, obj) => {
  const input = $("file-input");
  Object.defineProperty(input, "files", { value: [new window.File([JSON.stringify(obj)], name, { type: "application/json" })], configurable: true });
  fire(input, "change");
  await sleep(150);
};
tab("profile");
await waitFor(() => $("builder").querySelector(".call"), "builder visible");
await loadFile("cfg.json", { app: "hs_advertiser", version: VER, calls: [{ method: "config.set", params: { led: { blink_hz: 7 } } }, { method: "device.reboot" }] });
await waitFor(() => editorScript().calls.length === 2 && editorScript().calls[0].params.led.blink_hz === 7, "config file loaded into the editor");
assert.match($("validation").textContent, /✓ valid · 2 calls · unsaved changes/);
assert.equal($("builder").querySelectorAll(".call").length, 2, "form shows the loaded calls");
const before2 = alerts.length;
await loadFile("profile.json", { kind: "profile", name: "from-file", app: "hs_advertiser", version: VER, rf_stack: "v2",
                                 config_name: "filecfg", script: { calls: [{ method: "config.reset" }] } });
await waitFor(() => [...$("profile-select").options].some(o => o.textContent === "from-file"), "imported profile listed");
assert.ok(alerts.slice(before2).some(a => /Imported profile "from-file"/.test(a)));
await waitFor(() => pushed.some(b => b.profiles?.some(p => p.name === "from-file" && p.rf_stack === "v2")), "imported profile synced");
await loadFile("bad.json", { kind: "profile", name: "bad", app: "hs_advertiser", version: VER, script: { calls: [{ method: "config.set", params: { colour: "red" } }] } });
assert.ok(alerts.some(a => /isn't valid for hs_advertiser.*colour: unknown setting/s.test(a)), "invalid profile file refused");
await loadFile("junk.json", { hello: 1 });
assert.ok(alerts.some(a => /isn't a config .* or a profile file/.test(a)));
ok("Files: config script loads into the editor; whole profile imported + synced; invalid and unknown files refused");

// ---------- single-blink: an on/off setting has one switch, not an extra include tick ----------
tab("profile");
$("app").value = "single-blink"; fire($("app"), "change");
await waitFor(() => [...$("builder").querySelectorAll(".fld-head label")].some(l => l.textContent === "on ms"), "single-blink form");
const enabledFld = [...$("builder").querySelectorAll(".fld")].find(f => f.querySelector(".fld-head label")?.textContent === "enabled");
assert.equal(enabledFld.querySelectorAll('input[type=checkbox]').length, 1, "only the on/off switch itself");
assert.ok(!enabledFld.classList.contains("off"));
const sw = enabledFld.querySelector('input[type=checkbox]');
sw.checked = false; fire(sw, "change");
assert.equal(editorScript().calls[0].params.led.enabled, false, "switch off -> enabled: false is sent");
const onMs = [...$("builder").querySelectorAll(".fld")].find(f => f.querySelector(".fld-head label")?.textContent === "on ms");
assert.equal(onMs.querySelectorAll('.fld-head input[type=checkbox]').length, 1, "non-boolean optional settings keep their include tick");
assert.deepEqual(validateScriptFor(editorScript(), sbMethods), [], "valid for single-blink");
ok("single-blink form: 'enabled' is one switch (no extra checkbox); other optional settings keep the include tick");

// ---------- Fleet ----------
tab("fleet");
await waitFor(() => window.document.querySelectorAll("#fleet-groups .dev").length === 2, "fleet devices");
const group = window.document.querySelector("#fleet-groups .group");
assert.match(group.querySelector(".group-head").textContent, /fast-blink.*RF v1.*2 devices/s);
const rows = [...window.document.querySelectorAll("#fleet-groups .dev")];
assert.match(rows[0].textContent, /hs-01.*58e6c513033c.*-57 dBm.*capture 99\.77%.*missed 40/s, "hs-01 metrics (derived BLE address)");
assert.match(rows[1].textContent, /hs-02.*58e6c5195088.*-51 dBm.*capture 100%/s, "hs-02 metrics (recorded BLE address)");
assert.match($("unprovisioned").textContent, /hs-09.*11:22:33:44:55:66/s, "heard-but-unprovisioned board listed");
ok("Fleet: grouped by profile, sorted by board, metrics joined, unprovisioned section");

click(rows[1].querySelector(".dev-row"));
await waitFor(() => window.document.querySelector("#fleet-groups .dev.open"), "expand");
const open = window.document.querySelector("#fleet-groups .dev.open");
assert.match(open.textContent, /History \(1\)/);
assert.match(open.textContent, /flashed v1\.2\.0 → v1\.3\.0-test/);
click([...open.querySelectorAll("button")].find(b => b.textContent === "Collapse"));
await waitFor(() => !window.document.querySelector("#fleet-groups .dev.open"), "collapse");
click(window.document.querySelectorAll("#fleet-groups .dev")[1].querySelector(".dev-row"));
await waitFor(() => window.document.querySelector("#fleet-groups .dev.open"), "expand again");
ok("Fleet: device row expands to details + history and collapses again");

click([...window.document.querySelector("#fleet-groups .dev.open").querySelectorAll("button")].find(b => b.textContent === "Deploy to this device"));
await waitFor(() => !window.document.querySelector('[data-panel="deploy"]').classList.contains("hidden"), "jump to deploy");
assert.match($("target-line").textContent, /Target: hs-02 · 58e6c5195088 \(only this node will be offered\)/);
click($("target-line").querySelector("button"));
assert.match($("target-line").textContent, /any hs-\* node/);
ok("Fleet -> Deploy: targets that node (chooser filtered by name), target can be cleared");

// ---------- Alerts panel ----------
click($("bell"));
await waitFor(() => !$("alerts-card").classList.contains("hidden") && $("threshold").value === "35", "alerts panel with threshold");
assert.match($("threshold-info").textContent, /Currently 35 °C, back to normal below 34 °C · default/);
assert.equal($("alerts-on").checked, false, "not subscribed in this browser");
$("threshold").value = "33"; fire($("threshold"), "input");
assert.equal($("threshold-range").value, "33", "slider follows the number box");
$("clear-below").value = "32"; fire($("clear-below"), "input");
click($("threshold-save"));
await waitFor(() => savedThresholds.includes(33) && /Currently 33 °C, back to normal below 32 °C · set/.test($("threshold-info").textContent), "threshold saved");
$("threshold").value = "30"; $("clear-below").value = "31";
click($("threshold-save"));
assert.ok(alerts.some(a => /must be lower/.test(a)), "clear-below must be under the threshold");
ok("Alerts: bell opens the panel; threshold loads, saves to the server, validated");

// ---------- Gateway tab ----------
const { IdbStore } = await import(new URL("static/store.js", here).href);
const s2 = await IdbStore.open();
await s2.put("gateway", { id: "58:E6:C5:19:50:8A:1:5", address: "58:E6:C5:19:50:8A", board_id: 2, name: "hs-02", counter: 1, temp_c: 30,
                          uptime_s: 5, received_at: new Date().toISOString() });
tab("gateway");
await waitFor(() => /1 reading waiting to upload/.test($("gw-pending").textContent), "pending gateway reading shown");
assert.match($("st-pending").textContent, /1 to sync/, "counted in the header too");
click($("gw-upload"));
await waitFor(() => gatewayUploads.length === 1 && /Nothing waiting/.test($("gw-pending").textContent), "uploaded");
assert.match($("gw-log").textContent, /uploaded 1 gateway reading/);
ok("Gateway: pending readings shown, uploaded on sync, cleared");

console.log(`\n${passed} UI checks passed`);
process.exit(0);
