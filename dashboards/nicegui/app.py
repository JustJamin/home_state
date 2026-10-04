"""home_state on NiceGUI: Python-only UI, with the server pushing updates over a WebSocket.

Shows: a per-browser page whose timer fetches only *new* rows (incremental
updates, not reloads), ECharts gauge and zoomable line chart, a live log,
toast notifications when a board goes stale or recovers, a paginated table,
and a dark-mode switch. No HTML/JS written by hand.
"""

import os
from datetime import datetime, timezone

from nicegui import app, ui
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

DUMMY_DATA_BEFORE = datetime(2026, 10, 4, 20, 30, 52, tzinfo=timezone.utc)
STALE_SECONDS = 30
RANGES = {"15 min": 15, "1 h": 60, "6 h": 360, "24 h": 1440}
COLUMNS = """id, received_at, 'hs-' || lpad(board_id::text, 2, '0') AS board,
             counter, temp_c, rssi, uptime_s"""

pool = AsyncConnectionPool(os.environ["DATABASE_URL"], min_size=1, max_size=4, open=False,
                           kwargs={"row_factory": dict_row})

# wrapped: NiceGUI may pass the app object to handlers, which pool.open/close would take as a timeout
async def open_pool() -> None:
    await pool.open()


async def close_pool() -> None:
    await pool.close()


app.on_startup(open_pool)
app.on_shutdown(close_pool)


async def fetch(sql: str, params: tuple) -> list[dict]:
    async with pool.connection() as conn:
        return await (await conn.execute(sql, params)).fetchall()


def gauge_options() -> dict:
    return {
        "series": [{
            "type": "gauge", "min": 15, "max": 45, "progress": {"show": True},
            "detail": {"formatter": "{value} °C", "fontSize": 22},
            "axisLine": {"lineStyle": {"color": [[0.5, "#5b8ff9"], [0.8, "#f6bd16"], [1, "#e8684a"]]}},
            "data": [{"value": 0, "name": "chip"}],
        }],
    }


def line_options() -> dict:
    return {
        "tooltip": {"trigger": "axis"},
        "legend": {"top": 0},
        "grid": {"left": 45, "right": 45, "top": 30, "bottom": 60},
        "xAxis": {"type": "time"},
        "yAxis": [{"type": "value", "name": "°C", "scale": True},
                  {"type": "value", "name": "dBm", "scale": True, "splitLine": {"show": False}}],
        "dataZoom": [{"type": "inside"}, {"type": "slider"}],
        "series": [],
    }


@ui.page("/")
async def index() -> None:
    state = {"last_id": 0, "stale": False, "minutes": 60}
    series: dict[str, dict] = {}  # name -> echarts series dict

    dark = ui.dark_mode()
    with ui.header().classes("items-center justify-between"):
        ui.label("🌡️ home_state · NiceGUI").classes("text-h6")
        with ui.row().classes("items-center"):
            ui.label("server push over WebSocket").classes("text-caption opacity-80")
            ui.switch("Dark", on_change=lambda e: dark.set_value(e.value))

    with ui.row().classes("w-full items-center"):
        range_toggle = ui.toggle(list(RANGES), value="1 h")
        status = ui.badge("connecting…", color="grey").classes("text-sm")

    with ui.row().classes("w-full no-wrap max-sm:flex-wrap"):
        with ui.card().classes("w-80"):
            gauge = ui.echart(gauge_options()).classes("w-full h-56")
            stats = ui.label().classes("text-caption")
        with ui.card().classes("grow"):
            chart = ui.echart(line_options()).classes("w-full h-72")

    with ui.row().classes("w-full no-wrap max-sm:flex-wrap"):
        with ui.card().classes("w-96"):
            ui.label("Live feed").classes("text-subtitle2")
            feed = ui.log(max_lines=200).classes("w-full h-64 text-xs")
        with ui.card().classes("grow"):
            table = ui.table(
                rows=[], row_key="id", pagination=10,
                columns=[{"name": c, "label": l, "field": c, "sortable": True}
                         for c, l in [("time", "received"), ("board", "board"), ("counter", "counter"),
                                      ("temp_c", "temp °C"), ("rssi", "RSSI dBm")]],
            ).classes("w-full")

    def add_rows(rows: list[dict]) -> None:
        for r in rows:
            t = r["received_at"].isoformat()
            s = series.setdefault(r["board"], {"temp": {"name": f"{r['board']} temp", "type": "line",
                                                        "step": "end", "showSymbol": False, "data": []},
                                               "rssi": {"name": f"{r['board']} RSSI", "type": "scatter",
                                                        "yAxisIndex": 1, "symbolSize": 4, "data": []}})
            s["temp"]["data"].append([t, r["temp_c"]])
            s["rssi"]["data"].append([t, r["rssi"]])
            table.rows.insert(0, {"id": r["id"], "time": r["received_at"].strftime("%H:%M:%S"),
                                  "board": r["board"], "counter": r["counter"],
                                  "temp_c": r["temp_c"], "rssi": r["rssi"]})
            state["last_id"] = r["id"]
        del table.rows[500:]
        chart.options["series"] = [x for s in series.values() for x in (s["temp"], s["rssi"])]

    async def reload() -> None:
        state["minutes"] = RANGES[range_toggle.value]
        series.clear()
        table.rows.clear()
        rows = await fetch(f"""SELECT {COLUMNS} FROM readings
                               WHERE received_at > now() - make_interval(mins => %s) AND received_at >= %s
                               ORDER BY id""", (state["minutes"], DUMMY_DATA_BEFORE))
        add_rows(rows)
        feed.push(f"loaded {len(rows)} readings for the last {range_toggle.value}")
        render(rows[-1] if rows else None)

    def render(latest: dict | None) -> None:
        if latest:
            gauge.options["series"][0]["data"][0] = {"value": latest["temp_c"], "name": latest["board"]}
            stats.set_text(f"{latest['board']} · {latest['rssi']} dBm · counter {latest['counter']} · "
                           f"uptime {latest['uptime_s']} s")
        gauge.update()
        chart.update()
        table.update()

    async def tick() -> None:
        # incremental: only rows we haven't seen yet
        rows = await fetch(f"SELECT {COLUMNS} FROM readings WHERE id > %s ORDER BY id", (state["last_id"],))
        if rows:
            add_rows(rows)
            for r in rows:
                feed.push(f"{r['received_at']:%H:%M:%S}  {r['board']}  #{r['counter']}  "
                          f"{r['temp_c']} °C  {r['rssi']} dBm")
            render(rows[-1])

        newest = (await fetch("SELECT max(received_at) AS t FROM readings", ()))[0]["t"]
        age = (datetime.now(timezone.utc) - newest).total_seconds() if newest else None
        if age is not None and age > STALE_SECONDS:
            status.set_text(f"stale: {age:.0f} s since last reading")
            status.props("color=negative")
            if not state["stale"]:
                ui.notify(f"No readings for {age:.0f} s", type="warning", position="top-right")
            state["stale"] = True
        else:
            status.set_text("live")
            status.props("color=positive")
            if state["stale"]:
                ui.notify("Readings are arriving again", type="positive", position="top-right")
            state["stale"] = False

    range_toggle.on_value_change(reload)
    await reload()
    ui.timer(2.0, tick)


ui.run(host="0.0.0.0", port=8080, title="home_state · NiceGUI", reload=False, show=False,
       favicon="🌡️")
