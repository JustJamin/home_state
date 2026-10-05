"""home_state with FastAPI + plain HTML/JS: a JSON API, a Server-Sent Events stream, and a static page.

Shows: no frontend framework at all. The browser loads history from
/api/readings, then holds one EventSource on /api/stream; the server pushes
each new row the moment it sees it (polling Postgres once a second, so N
browsers cost one query per second, not N). EventSource reconnects by itself
and resumes from Last-Event-ID, so no rows are missed across reconnects.

It also hosts the provisioning web app (static/provision.html, an offline-
capable PWA) and its API in provisioning.py: firmware catalogue, config /
profile / deployment sync, and the fleet view.
"""

import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Header, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

import alerts
import provisioning

DUMMY_DATA_BEFORE = datetime(2026, 10, 4, 20, 30, 52, tzinfo=timezone.utc)
COLUMNS = """id, received_at, 'hs-' || lpad(board_id::text, 2, '0') AS board, address,
             counter, temp_c, rssi, uptime_s, source"""
STATIC = Path(__file__).parent / "static"

pool = AsyncConnectionPool(os.environ["DATABASE_URL"], min_size=1, max_size=4, open=False,
                           kwargs={"row_factory": dict_row})


class Broadcaster:
    """One DB poller fanning new rows out to every connected browser."""

    def __init__(self) -> None:
        self.subscribers: set[asyncio.Queue] = set()
        self.last_id = 0

    async def run(self) -> None:
        async with pool.connection() as conn:
            row = await (await conn.execute("SELECT coalesce(max(id), 0) AS id FROM readings")).fetchone()
            self.last_id = row["id"]
        # Poll even with no browsers connected, so last_id stays current and the
        # first browser to connect doesn't get a burst of old rows.
        while True:
            await asyncio.sleep(1)
            try:
                async with pool.connection() as conn:
                    rows = await (await conn.execute(
                        f"SELECT {COLUMNS} FROM readings WHERE id > %s ORDER BY id", (self.last_id,)
                    )).fetchall()
            except Exception as e:  # DB restart etc.: keep the stream alive, try again next second
                print(f"poll failed: {e}", flush=True)
                continue
            for r in rows:
                self.last_id = r["id"]
                for q in self.subscribers:
                    q.put_nowait(r)
                events = alerts.engine.observe(r["address"], r["board"], r["temp_c"])
                if events:
                    asyncio.create_task(alerts.notify(events))


broadcaster = Broadcaster()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await pool.open()
    provisioning.readings_pool = pool
    if provisioning.pool:
        await provisioning.pool.open()
        alerts.pool = provisioning.pool
        try:
            await alerts.load_settings()
        except Exception as e:  # e.g. migration 006 not applied yet: keep the defaults
            print(f"alert settings not loaded: {e}", flush=True)
    task = asyncio.create_task(broadcaster.run())
    yield
    task.cancel()
    await pool.close()
    if provisioning.pool:
        await provisioning.pool.close()


app = FastAPI(title="home_state · FastAPI + SSE", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")
app.include_router(provisioning.router)
app.include_router(alerts.router)


def to_json(r: dict) -> str:
    return json.dumps({**r, "received_at": r["received_at"].isoformat()})


@app.get("/api/readings")
async def readings(minutes: int = Query(60, ge=1, le=10080)) -> list[dict]:
    async with pool.connection() as conn:
        return await (await conn.execute(
            f"""SELECT {COLUMNS} FROM readings
                WHERE received_at > now() - make_interval(mins => %s) AND received_at >= %s
                ORDER BY id""", (minutes, DUMMY_DATA_BEFORE),
        )).fetchall()


@app.get("/api/stream")
async def stream(request: Request, last_event_id: int | None = Header(None)) -> StreamingResponse:
    q: asyncio.Queue = asyncio.Queue()

    async def events():
        broadcaster.subscribers.add(q)  # subscribe first so nothing slips past during replay
        sent = last_event_id or 0
        try:
            yield "retry: 3000\n\n"
            if last_event_id is not None:  # browser reconnected: replay what it missed
                async with pool.connection() as conn:
                    missed = await (await conn.execute(
                        f"SELECT {COLUMNS} FROM readings WHERE id > %s ORDER BY id",
                        (last_event_id,))).fetchall()
                for r in missed:
                    sent = r["id"]
                    yield f"id: {r['id']}\nevent: reading\ndata: {to_json(r)}\n\n"
            while not await request.is_disconnected():
                try:
                    r = await asyncio.wait_for(q.get(), timeout=15)
                    if r["id"] <= sent:  # already sent during replay
                        continue
                    sent = r["id"]
                    yield f"id: {r['id']}\nevent: reading\ndata: {to_json(r)}\n\n"
                except TimeoutError:
                    yield ": keepalive\n\n"  # comment line; stops proxies timing out the connection
        finally:
            broadcaster.subscribers.discard(q)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/fleet/metrics")
async def fleet_metrics(hours: int = Query(24, ge=1, le=720)) -> list[dict]:
    """Network health per BLE address over the window, from the scanner's readings.

    missed = gaps in a board's counter (adverts nobody stored, including scanner
    outages); a counter that goes down is a reboot, counted in `resets` instead.
    """
    async with pool.connection() as conn:
        rows = await (await conn.execute("""
            WITH r AS (
                SELECT address, board_id, received_at, rssi, uptime_s, temp_c,
                       counter - lag(counter) OVER (PARTITION BY address ORDER BY id) AS d
                FROM readings WHERE received_at > now() - make_interval(hours => %s)
            )
            SELECT address,
                   (array_agg(board_id ORDER BY received_at DESC))[1] AS board_id,
                   max(received_at) AS last_seen,
                   (array_agg(rssi ORDER BY received_at DESC))[1] AS rssi_last,
                   round(avg(rssi) FILTER (WHERE received_at > now() - interval '1 hour'))::int AS rssi_avg_1h,
                   count(*) AS readings,
                   coalesce(sum(d - 1) FILTER (WHERE d > 1), 0)::int AS missed,
                   count(*) FILTER (WHERE d < 0) AS resets,
                   (array_agg(uptime_s ORDER BY received_at DESC))[1] AS uptime_s,
                   (array_agg(temp_c ORDER BY received_at DESC))[1] AS temp_c
            FROM r GROUP BY address ORDER BY address""", (hours,))).fetchall()
    for r in rows:
        total = r["readings"] + r["missed"]
        r["capture_pct"] = round(100 * r["readings"] / total, 2) if total else None
        r["last_seen"] = r["last_seen"].isoformat()
        r["window_hours"] = hours
    return rows


@app.get("/api/stats")
async def stats() -> dict:
    return {"browsers_connected": len(broadcaster.subscribers), "last_id": broadcaster.last_id}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/provision")
async def provision() -> FileResponse:
    return FileResponse(STATIC / "provision.html", headers={"Cache-Control": "no-cache"})


# PWA: the service worker must be served from / so its scope covers the whole app
@app.get("/sw.js")
async def service_worker() -> FileResponse:
    return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
async def manifest() -> FileResponse:
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json",
                        headers={"Cache-Control": "no-cache"})
