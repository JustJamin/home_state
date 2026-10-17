# dashboards

The home_state dashboard and Admin app: FastAPI, Server-Sent Events and plain HTML/JS. It reads the `readings` table as the read-only `dashboards` Postgres role, runs in k3s and is reachable on the tailnet only: http://100.79.164.117:30304 (lenovo's Tailscale IP), or as the installed app at https://lenovo.tailc2dfa5.ts.net/. It hides the dummy temperatures from before 2026-10-04 20:30:52 UTC.

Grafana and the Streamlit, Plotly Dash and NiceGUI demos that used to run beside it (ports 30300–30303) were retired after v1.3.5; their code is in git history.

## How it works

*No framework at all.*
- `GET /api/readings` (history as JSON), `GET /api/stream` (SSE) and `GET /api/stats`. The OpenAPI docs are at `/docs`.
- **One** Postgres poller fans out to every connected browser, so N browsers cost one query a second.
- The browser's `EventSource` reconnects automatically and sends `Last-Event-ID`. The server replays exactly the rows that browser missed, with no duplicates.
- About 150 lines of vanilla JS: uPlot charts (drag to zoom, double-click to reset), new table rows flash as they arrive, a connection-status dot, and light/dark colours from `prefers-color-scheme`.
- uPlot is vendored in `static/vendor/` (v1.6.32, MIT), so no CDN is needed.
- **Provisioning (`/provision`, v1.3.0):** themed in the Lacuna Space colours, like the dashboard itself, from `static/theme.css`. It's an installable, **offline-capable** web app (PWA) for Chrome on Android over HTTPS: https://lenovo.tailc2dfa5.ts.net/provision.
  - **Build:** pick App → Version → **Radio stack** (the versions that firmware declares in `methods.json`'s `rf_stacks`; stored with the profile, not yet sent to the node) → Config. Each version ships a `default` config; saved ones are listed too.
    - **Form** view: generated from `methods.json`. Sliders with a number box for ranges, dropdowns for enums, toggles, and nested groups. Optional settings have an include tick, because `config.set` only changes what you send. You can add, remove and reorder calls.
    - **JSON** view: the raw script, as a fallback. Both views edit the same script, with live validation.
    - Then **Save config as…** and **Save as profile…**.
  - **Deploy:** pick a profile from the dropdown; only that profile is shown, with its firmware, radio stack and calls. One tap: identify the node (device ID over JSON-RPC), flash if it runs another version, optionally set a board ID, run the script (reconnecting after reboots), and record the result. From the Fleet tab you can **target one node**, and the Bluetooth chooser then offers only that name.
  - **Apps (v1.3.1):** `single-blink` and `double-blink`, plus the legacy `hs_advertiser` bridge. Each version of each app has its own configs, validated against its own schema. A profile for another app **switches the board's app** on deploy, provided the node has v1.3.1+ firmware or the bridge.
  - **Alerts (v1.3.1):** the 🔔 in the header opens the alerts panel:
    - **subscribe this phone** to Web Push, so notifications arrive even with the app closed;
    - set the **fleet-wide threshold** and its "back to normal" level, stored on the server, which sends the alerts;
    - **send a test alert**.

    One alert per board when it crosses the threshold, one when it recovers, at most one high alert per 10 min. Tapping a notification opens the dashboard in the app.
  - **Gateway (v1.3.1, manual collect):** the Gateway tab connects to a node and downloads its buffered last hour of readings (`readings.read`). It works offline. Readings are kept on the phone and uploaded with sync, and the server skips any it already has from the scanner.
  - **Fleet:** devices grouped by the profile they run (their last successful deploy), sorted by profile then board. Each row shows the scanner's **network metrics**: last seen, RSSI, 24 h capture %, missed counters (from `/api/fleet/metrics`). Tap a row to expand details and history, and tap again to collapse. Boards the scanner hears that have no deployment yet are listed separately.
  - **Offline:** configs, profiles and deployments live in the phone's IndexedDB and sync with Postgres (`provisioning` schema) whenever the server is reachable. Records are immutable with client UUIDs, so syncing never conflicts. The service worker keeps the app shell, and Cache Storage keeps the firmware for every profile's version plus the newest version, plus anything marked "keep offline".
  - API: `/api/apps` (catalogue), `/api/apps/<app>/<version>/{firmware.bin,default.config.json,methods.json}`, `/api/sync` (GET `?since=`, POST batch), `/api/fleet`, `/api/fleet/metrics?hours=24`. Docs: [docs/jsonrpc.md](../docs/jsonrpc.md), [docs/ota-protocol.md](../docs/ota-protocol.md).
  - Tests: `tests/run.sh` (pytest against a throwaway Postgres: catalogue, validation, radio stack rules, sync, fleet + metrics, role permissions). `npm install && npm test` runs `test_provision.mjs` (validator, RPC framing, deploy runner, offline sync, builder and fleet models), `test_ota.mjs` (OTA client) and `tests/ui_smoke.mjs` (the real `app.js` in jsdom, driven through Build → Deploy → Fleet). The app itself has no npm dependencies; `package.json` is only for the tests.

## Running locally

```sh
kubectl -n home-state port-forward pod/postgres-0 15432:5432 &
export DATABASE_URL=postgresql://dashboards:<password>@127.0.0.1:15432/home_state
cd dashboards/fastapi-sse && pip install -r requirements.txt && uvicorn app:app --reload   # port 8000
```

After changing it: `deploy/push-dashboards.sh`.
