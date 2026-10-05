"""home_state with FastAPI + plain HTML/JS: a JSON API, a Server-Sent Events stream, and a static page.

Shows: no frontend framework at all. The browser loads history from
/api/readings, then holds one EventSource on /api/stream; the server pushes
each new row the moment it sees it (polling Postgres once a second, so N
browsers cost one query per second, not N). EventSource reconnects by itself
and resumes from Last-Event-ID, so no rows are missed across reconnects.

It also serves firmware images for the BLE provisioning page
(static/provision.html): /api/firmware lists the .bin files in firmware/,
with metadata read from each image's own header.
"""

import asyncio
import json
import hashlib
import os
import re
import struct
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

DUMMY_DATA_BEFORE = datetime(2026, 10, 4, 20, 30, 52, tzinfo=timezone.utc)
COLUMNS = """id, received_at, 'hs-' || lpad(board_id::text, 2, '0') AS board,
             counter, temp_c, rssi, uptime_s"""
STATIC = Path(__file__).parent / "static"
FIRMWARE_DIR = Path(os.environ.get("FIRMWARE_DIR", Path(__file__).parent / "firmware"))
FIRMWARE_NAME = re.compile(r"^hs_advertiser-[A-Za-z0-9._+-]+\.bin$")

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


broadcaster = Broadcaster()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await pool.open()
    task = asyncio.create_task(broadcaster.run())
    yield
    task.cancel()
    await pool.close()


app = FastAPI(title="home_state · FastAPI + SSE", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def image_meta(path: Path) -> dict | None:
    """Metadata from an ESP-IDF app image: esp_app_desc_t sits at offset 32."""
    img = path.read_bytes()
    if len(img) < 32 + 176 or img[0] != 0xE9 or struct.unpack_from("<I", img, 32)[0] != 0xABCD5432:
        return None
    field = lambda off, n: img[32 + off: 32 + off + n].split(b"\0")[0].decode(errors="replace")
    built = " ".join(field(96, 16).split()) + " " + field(80, 16)
    try:
        built = datetime.strptime(built, "%b %d %Y %H:%M:%S").isoformat()
    except ValueError:
        pass
    return {"file": path.name, "project": field(48, 32), "version": field(16, 32), "idf": field(112, 32),
            "built": built, "size": len(img), "sha256": hashlib.sha256(img).hexdigest()}


def firmware_catalogue() -> dict[str, dict]:
    entries = []
    for p in FIRMWARE_DIR.glob("hs_advertiser-*.bin"):
        if FIRMWARE_NAME.match(p.name) and (meta := image_meta(p)):
            entries.append(meta)
    entries.sort(key=lambda m: m["built"], reverse=True)
    return {m["file"]: m for m in entries}


@app.get("/api/firmware")
async def firmware_list() -> list[dict]:
    return list(firmware_catalogue().values())


@app.get("/api/firmware/{name}")
async def firmware_file(name: str) -> FileResponse:
    if not FIRMWARE_NAME.match(name) or name not in firmware_catalogue():
        raise HTTPException(404, "no such firmware")
    # released images never change under the same name
    return FileResponse(FIRMWARE_DIR / name, media_type="application/octet-stream",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


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


@app.get("/api/stats")
async def stats() -> dict:
    return {"browsers_connected": len(broadcaster.subscribers), "last_id": broadcaster.last_id}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/provision")
async def provision() -> FileResponse:
    return FileResponse(STATIC / "provision.html", headers={"Cache-Control": "no-cache"})
