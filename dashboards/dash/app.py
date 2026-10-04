"""home_state on Plotly Dash: a declarative layout plus callbacks.

Shows: dcc.Interval driving live updates, callbacks with several inputs and
outputs, Plotly figures with a range slider, `uirevision` so zoom survives
data refreshes, cross-filtering (zoom the temperature chart and the table
follows), and a sortable/filterable DataTable.
"""

import os
from datetime import datetime, timezone

import pandas as pd
import plotly.express as px
from dash import Dash, Input, Output, callback, dash_table, dcc, html
from psycopg_pool import ConnectionPool

DUMMY_DATA_BEFORE = datetime(2026, 10, 4, 20, 30, 52, tzinfo=timezone.utc)
RANGES = {"15m": 15, "1h": 60, "6h": 360, "24h": 1440, "7d": 10080}

pool = ConnectionPool(os.environ["DATABASE_URL"], min_size=1, max_size=4, open=True)


def load(minutes: int) -> pd.DataFrame:
    with pool.connection() as conn:
        cur = conn.execute(
            """SELECT received_at, 'hs-' || lpad(board_id::text, 2, '0') AS board,
                      counter, temp_c, rssi, uptime_s
               FROM readings
               WHERE received_at > now() - make_interval(mins => %s)
                 AND received_at >= %s
               ORDER BY received_at""",
            (minutes, DUMMY_DATA_BEFORE),
        )
        return pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])


def card(label: str, id_: str) -> html.Div:
    return html.Div([html.Div(label, className="label"), html.Div(id=id_, className="value")], className="card")


app = Dash(__name__, title="home_state · Dash")
server = app.server  # for gunicorn

app.layout = html.Div([
    html.Header([
        html.H1("🌡️ home_state"),
        html.Span("Plotly Dash: callbacks, intervals, cross-filtering", className="sub"),
    ]),
    html.Div([
        dcc.RadioItems(list(RANGES), "1h", id="range", inline=True, className="radios"),
        dcc.Dropdown(id="boards", multi=True, placeholder="All boards", className="boards"),
        dcc.Checklist(["live"], ["live"], id="live", inline=True),
    ], className="controls"),
    html.Div([card("Latest temperature", "c-temp"), card("Signal", "c-rssi"),
              card("Readings", "c-count"), card("Last seen", "c-age")], className="cards"),
    dcc.Graph(id="temp", config={"displaylogo": False}),
    html.P("Tip: drag across the temperature chart to zoom; the table below follows the zoom.",
           className="tip"),
    dcc.Graph(id="rssi", config={"displaylogo": False}),
    html.H3(id="table-title"),
    dash_table.DataTable(
        id="table", page_size=15, sort_action="native", filter_action="native",
        columns=[{"name": n, "id": i} for n, i in [("received", "received"), ("board", "board"),
                                                    ("counter", "counter"), ("temp °C", "temp_c"),
                                                    ("RSSI dBm", "rssi"), ("uptime s", "uptime_s")]],
        style_cell={"fontFamily": "inherit", "padding": "4px 8px"},
        style_header={"fontWeight": "600"},
    ),
    dcc.Interval(id="tick", interval=5000),
])


@callback(Output("tick", "disabled"), Input("live", "value"))
def toggle_live(live):
    return "live" not in (live or [])


@callback(Output("boards", "options"), Input("range", "value"), Input("tick", "n_intervals"))
def board_options(range_key, _):
    return sorted(load(RANGES[range_key])["board"].unique())


@callback(
    Output("temp", "figure"), Output("rssi", "figure"),
    Output("c-temp", "children"), Output("c-rssi", "children"),
    Output("c-count", "children"), Output("c-age", "children"),
    Input("range", "value"), Input("boards", "value"), Input("tick", "n_intervals"),
)
def refresh(range_key, boards, _):
    df = load(RANGES[range_key])
    if boards:
        df = df[df["board"].isin(boards)]

    temp = px.line(df, x="received_at", y="temp_c", color="board", line_shape="hv",
                   labels={"received_at": "", "temp_c": "°C"}, title="Chip temperature")
    temp.update_xaxes(rangeslider_visible=True)
    rssi = px.scatter(df, x="received_at", y="rssi", color="board", opacity=0.6,
                      labels={"received_at": "", "rssi": "dBm"}, title="Signal strength")
    for fig in (temp, rssi):
        # same uirevision on every refresh = keep the user's zoom/pan
        fig.update_layout(uirevision=range_key, margin=dict(l=40, r=20, t=50, b=20), height=320)

    if df.empty:
        return temp, rssi, "–", "–", "0", "–"
    latest = df.iloc[-1]
    age = (datetime.now(timezone.utc) - latest["received_at"]).total_seconds()
    return (temp, rssi, f"{latest['temp_c']:.1f} °C", f"{latest['rssi']} dBm",
            f"{len(df):,}", f"{age:.0f} s ago")


@callback(
    Output("table", "data"), Output("table-title", "children"),
    Input("range", "value"), Input("boards", "value"), Input("tick", "n_intervals"),
    Input("temp", "relayoutData"),
)
def table(range_key, boards, _, relayout):
    df = load(RANGES[range_key])
    if boards:
        df = df[df["board"].isin(boards)]
    title = "Readings"
    # cross-filter: if the temperature chart is zoomed, only show that window
    if relayout and "xaxis.range[0]" in relayout:
        lo = pd.Timestamp(relayout["xaxis.range[0]"], tz="UTC")
        hi = pd.Timestamp(relayout["xaxis.range[1]"], tz="UTC")
        df = df[(df["received_at"] >= lo) & (df["received_at"] <= hi)]
        title = f"Readings {lo:%H:%M:%S}–{hi:%H:%M:%S} UTC (from chart zoom)"
    df = df.iloc[::-1].copy()
    df["received"] = df["received_at"].dt.strftime("%Y-%m-%d %H:%M:%S")
    return df.drop(columns="received_at").to_dict("records"), f"{title}: {len(df):,} rows"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8050, debug=True)
