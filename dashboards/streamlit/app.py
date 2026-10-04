"""home_state on Streamlit: the whole page is a script that reruns top to bottom.

Shows: sidebar widgets driving the query, cached queries (st.cache_data),
a live fragment that reruns on a timer without reloading the page,
st.metric with deltas, Altair charts, tabs, a dataframe and CSV download.
"""

import os
from datetime import datetime, timezone

import altair as alt
import pandas as pd
import streamlit as st
from psycopg_pool import ConnectionPool

DUMMY_DATA_BEFORE = datetime(2026, 10, 4, 20, 30, 52, tzinfo=timezone.utc)
RANGES = {"15 minutes": 15, "1 hour": 60, "6 hours": 360, "24 hours": 1440, "7 days": 10080}

st.set_page_config(page_title="home_state · Streamlit", page_icon="🌡️", layout="wide")


@st.cache_resource
def pool() -> ConnectionPool:
    return ConnectionPool(os.environ["DATABASE_URL"], min_size=1, max_size=4, open=True)


@st.cache_data(ttl=5, show_spinner=False)
def load(minutes: int) -> pd.DataFrame:
    with pool().connection() as conn:
        cur = conn.execute(
            """SELECT received_at, 'hs-' || lpad(board_id::text, 2, '0') AS board,
                      counter, temp_c, rssi, uptime_s
               FROM readings
               WHERE received_at > now() - make_interval(mins => %s)
               ORDER BY received_at""",
            (minutes,),
        )
        cols = [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


# ---- sidebar: every widget change reruns the script with new values ----
with st.sidebar:
    st.header("Filters")
    range_label = st.selectbox("Time range", list(RANGES), index=1)
    hide_dummy = st.toggle("Hide dummy data", value=True,
                           help=f"Rows before {DUMMY_DATA_BEFORE:%Y-%m-%d %H:%M} UTC are fake temperatures")
    live = st.toggle("Live (refresh every 5 s)", value=True)
    st.divider()
    st.caption("Streamlit demo for home_state. Each widget change re-runs `app.py`; "
               "the live block below is an `st.fragment` that re-runs on its own timer.")

st.title("🌡️ home_state")
st.caption("BLE boards → scanner → Postgres → Streamlit")

all_boards = sorted(load(RANGES[range_label])["board"].unique())
boards = st.multiselect("Boards", all_boards, default=all_boards)


@st.fragment(run_every=5 if live else None)
def live_view(minutes: int, boards: list[str], hide_dummy: bool) -> None:
    df = load(minutes)
    if hide_dummy:
        df = df[df["received_at"] >= DUMMY_DATA_BEFORE]
    df = df[df["board"].isin(boards)]
    if df.empty:
        st.info("No readings in this range.")
        return

    latest = df.iloc[-1]
    earlier = df[df["received_at"] <= latest["received_at"] - pd.Timedelta(minutes=5)]
    prev_temp = earlier.iloc[-1]["temp_c"] if not earlier.empty else None
    age = (datetime.now(timezone.utc) - latest["received_at"]).total_seconds()

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Latest temperature", f"{latest['temp_c']:.1f} °C",
              delta=None if prev_temp is None else f"{latest['temp_c'] - prev_temp:+.1f} °C vs 5 min ago",
              delta_color="inverse")
    c2.metric("Signal", f"{latest['rssi']} dBm")
    c3.metric("Readings in range", f"{len(df):,}")
    c4.metric("Last seen", f"{age:.0f} s ago", delta="live" if age < 15 else "stale",
              delta_color="normal" if age < 15 else "inverse")

    chart_tab, dist_tab, data_tab = st.tabs(["📈 Charts", "📊 Distributions", "🗂️ Data"])

    with chart_tab:
        zoom = alt.selection_interval(bind="scales", encodings=["x"])
        base = alt.Chart(df).encode(
            x=alt.X("received_at:T", title=None),
            color=alt.Color("board:N", legend=alt.Legend(orient="top")),
            tooltip=["received_at:T", "board:N", "temp_c:Q", "rssi:Q", "counter:Q"],
        )
        temp = base.mark_line(interpolate="step-after").encode(
            y=alt.Y("temp_c:Q", title="°C", scale=alt.Scale(zero=False))).add_params(zoom)
        rssi = base.mark_circle(size=18, opacity=0.6).encode(y=alt.Y("rssi:Q", title="dBm"))
        st.altair_chart(temp.properties(height=260, title="Chip temperature (drag to pan, scroll to zoom)"),
                        width="stretch")
        st.altair_chart(rssi.properties(height=200, title="Signal strength"), width="stretch")

    with dist_tab:
        left, right = st.columns(2)
        left.altair_chart(
            alt.Chart(df).mark_bar().encode(x=alt.X("rssi:Q", bin=alt.Bin(maxbins=20), title="RSSI dBm"),
                                            y="count()", color="board:N").properties(height=260),
            width="stretch")
        per_min = df.set_index("received_at").groupby("board").resample("1min")["counter"].count().reset_index()
        right.altair_chart(
            alt.Chart(per_min).mark_bar().encode(x=alt.X("received_at:T", title=None),
                                                 y=alt.Y("counter:Q", title="readings / min"),
                                                 color="board:N").properties(height=260),
            width="stretch")

    with data_tab:
        st.dataframe(df.iloc[::-1], hide_index=True, width="stretch",
                     column_config={"received_at": st.column_config.DatetimeColumn("received", format="HH:mm:ss"),
                                    "temp_c": st.column_config.NumberColumn("temp °C", format="%.1f")})
        st.download_button("Download CSV", df.to_csv(index=False), file_name="readings.csv", mime="text/csv")


live_view(RANGES[range_label], boards, hide_dummy)
