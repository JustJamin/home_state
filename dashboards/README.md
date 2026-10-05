# dashboards

Four alternatives to Grafana, each built to show off its own stack. They all read the same `readings` table as the read-only `dashboards` Postgres role, run in k3s and are reachable on the tailnet only (lenovo's Tailscale IP `100.79.164.117`):

| Port | Stack | Open | Idle RAM |
|---|---|---|---|
| 30300 | Grafana (reference, `deploy/grafana/`) | http://100.79.164.117:30300 | ~360Mi |
| 30301 | [Streamlit](streamlit/app.py) | http://100.79.164.117:30301 | ~80Mi |
| 30302 | [Plotly Dash](dash/app.py) | http://100.79.164.117:30302 | ~115Mi |
| 30303 | [NiceGUI](nicegui/app.py) | http://100.79.164.117:30303 | ~80Mi |
| 30304 | [FastAPI + SSE + plain HTML/JS](fastapi-sse/) | http://100.79.164.117:30304 | ~40Mi |

All of them hide the dummy temperatures from before 2026-10-04 20:30:52 UTC. Streamlit has a toggle to show them.

## What each one demonstrates

**Streamlit**: *a script is the app.* The page is `app.py` run top to bottom. Any widget change reruns it.
- Sidebar filters: time range, hide dummy data, live on/off. Board multiselect.
- `st.cache_data(ttl=5)` so reruns don't hit the database every time.
- `st.fragment(run_every=5)`: just the live section reruns on a timer, not the whole page.
- `st.metric` with deltas ("vs 5 min ago").
- Tabs holding Altair charts: a zoomable step line, an RSSI scatter, histograms, and readings per minute.
- A dataframe with formatted columns, and a CSV download button.
- *Good for:* quick internal tools written in plain Python. *Trade-off:* the whole-script rerun model gets awkward for complex interactions.

**Plotly Dash**: *a declarative layout plus callbacks.*
- Callbacks connect inputs to outputs. `dcc.Interval` drives the live updates.
- Plotly charts with a range slider. `uirevision` keeps your zoom and pan while the data refreshes.
- **Cross-filtering:** drag-zoom the temperature chart and the table below shows only that time window.
- A DataTable with native sorting and filtering per column. CSS from `assets/` is picked up automatically.
- Served by gunicorn, because it's a plain Flask app underneath.
- *Good for:* analytical apps with linked views. *Trade-off:* more boilerplate, and all state passes through callbacks.

**NiceGUI**: *a Python UI whose state lives on the server and is pushed over a WebSocket.*
- Each browser gets its own page instance. A 2 s `ui.timer` fetches **only new rows** (`id > last_id`) and appends them, without reloading.
- ECharts: a temperature gauge, plus a dual-axis chart with a zoom slider (temperature and RSSI).
- A live feed (`ui.log`), and a paginated, sortable table (Quasar).
- **Toast notifications** when no reading has arrived for 30 s, and again when readings recover. A status badge shows the same.
- A dark-mode switch. No HTML or JS written by hand.
- *Good for:* app-like UIs with real-time push from Python. *Trade-off:* holds per-client state on the server.

**FastAPI + Server-Sent Events + plain HTML/JS**: *no framework at all.*
- `GET /api/readings` (history as JSON), `GET /api/stream` (SSE) and `GET /api/stats`. The OpenAPI docs are at `/docs`.
- **One** Postgres poller fans out to every connected browser, so N browsers cost one query a second.
- The browser's `EventSource` reconnects automatically and sends `Last-Event-ID`. The server replays exactly the rows that browser missed, with no duplicates.
- About 150 lines of vanilla JS: uPlot charts (drag to zoom, double-click to reset), new table rows flash as they arrive, a connection-status dot, and light/dark colours from `prefers-color-scheme`.
- uPlot is vendored in `static/vendor/` (v1.6.32, MIT), so no CDN is needed.
- *Good for:* the smallest footprint and full control, and it's the easiest to embed anywhere. *Trade-off:* you write everything yourself.
- **Provisioning (`/provision`, v1.3.0):** themed in the Lacuna Space colours, like the dashboard itself, from `static/theme.css`. It's an installable, **offline-capable** web app (PWA) for Chrome on Android over HTTPS: https://lenovo.tailc2dfa5.ts.net/provision.
  - **Build:** pick App → Version → **Radio stack** (the versions that firmware declares in `methods.json`'s `rf_stacks`; stored with the profile, not yet sent to the node) → Config. Each version ships a `default` config; saved ones are listed too.
    - **Form** view: generated from `methods.json`. Sliders with a number box for ranges, dropdowns for enums, toggles, and nested groups. Optional settings have an include tick, because `config.set` only changes what you send. You can add, remove and reorder calls.
    - **JSON** view: the raw script, as a fallback. Both views edit the same script, with live validation.
    - Then **Save config as…** and **Save as profile…**.
  - **Deploy:** pick a profile from the dropdown; only that profile is shown, with its firmware, radio stack and calls. One tap: identify the node (device ID over JSON-RPC), flash if it runs another version, optionally set a board ID, run the script (reconnecting after reboots), and record the result. From the Fleet tab you can **target one node**, and the Bluetooth chooser then offers only that name.
  - **Fleet:** devices grouped by the profile they run (their last successful deploy), sorted by profile then board. Each row shows the scanner's **network metrics**: last seen, RSSI, 24 h capture %, missed counters (from `/api/fleet/metrics`). Tap a row to expand details and history, and tap again to collapse. Boards the scanner hears that have no deployment yet are listed separately.
  - **Offline:** configs, profiles and deployments live in the phone's IndexedDB and sync with Postgres (`provisioning` schema) whenever the server is reachable. Records are immutable with client UUIDs, so syncing never conflicts. The service worker keeps the app shell, and Cache Storage keeps the firmware for every profile's version plus the newest version, plus anything marked "keep offline".
  - API: `/api/apps` (catalogue), `/api/apps/<app>/<version>/{firmware.bin,default.config.json,methods.json}`, `/api/sync` (GET `?since=`, POST batch), `/api/fleet`, `/api/fleet/metrics?hours=24`. Docs: [docs/jsonrpc.md](../docs/jsonrpc.md), [docs/ota-protocol.md](../docs/ota-protocol.md).
  - Tests: `tests/run.sh` (pytest against a throwaway Postgres: catalogue, validation, radio stack rules, sync, fleet + metrics, role permissions). `npm install && npm test` runs `test_provision.mjs` (validator, RPC framing, deploy runner, offline sync, builder and fleet models), `test_ota.mjs` (OTA client) and `tests/ui_smoke.mjs` (the real `app.js` in jsdom, driven through Build → Deploy → Fleet). The app itself has no npm dependencies; `package.json` is only for the tests.

## Other options not built here

- **Metabase / Apache Superset / Redash**: point-and-click BI over Postgres. Non-developers can build charts and questions in the UI. Heavy: Metabase needs about 1 GB of RAM, and Superset needs more plus Redis.
- **Evidence.dev / Observable Framework**: dashboards written as Markdown or JS with SQL, built into a static site. Great for reports, less so for live data.
- **Panel (HoloViz) / Gradio**: more Python options. Panel is close to Dash and Streamlit in feel; Gradio is aimed at ML demos.
- **Node-RED dashboard**: flow-based wiring, popular for home automation.

## Running locally

```sh
kubectl -n home-state port-forward pod/postgres-0 15432:5432 &
export DATABASE_URL=postgresql://dashboards:<password>@127.0.0.1:15432/home_state
cd dashboards/streamlit && pip install -r requirements.txt && streamlit run app.py
# dash:        python app.py            (dev server, port 8050)
# nicegui:     python app.py            (port 8080)
# fastapi-sse: uvicorn app:app --reload (port 8000)
```

After changing one: `deploy/push-dashboards.sh <name>` (or no name for all four).
