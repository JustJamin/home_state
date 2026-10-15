"""Write readings (and the scanner's heartbeats) to Postgres, reconnecting if the database goes away."""

import asyncio
import logging

import psycopg

log = logging.getLogger("db")

INSERT = """
    INSERT INTO readings (received_at, board_id, address, name, rssi, version, counter, temp_c, uptime_s)
    VALUES (%(ts)s, %(board_id)s, %(address)s, %(name)s, %(rssi)s, %(version)s, %(counter)s, %(temp_c)s, %(uptime_s)s)
"""

# one row, replaced on every heartbeat (migration 008)
HEARTBEAT = """
    INSERT INTO scanner_heartbeat (id, at, started_at, window_s, adverts, readings, last_advert_s)
    VALUES (1, now(), %(started_at)s, %(window_s)s, %(adverts)s, %(readings)s, %(last_advert_s)s)
    ON CONFLICT (id) DO UPDATE SET at = excluded.at, started_at = excluded.started_at,
        window_s = excluded.window_s, adverts = excluded.adverts, readings = excluded.readings,
        last_advert_s = excluded.last_advert_s
"""


async def _connect(url: str) -> psycopg.AsyncConnection:
    delay = 1
    while True:
        try:
            conn = await psycopg.AsyncConnection.connect(url, autocommit=True)
            log.info("connected to database")
            return conn
        except psycopg.OperationalError as e:
            log.warning("database connect failed (%s); retrying in %ss", e, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)


async def writer(url: str, queue: asyncio.Queue) -> None:
    """Insert each record from the queue. A lost connection is retried until the record
    lands; any other database error (bad data, a missing table) logs and skips that record,
    so one bad record can't stop everything after it being stored."""
    conn = await _connect(url)
    while True:
        record = await queue.get()
        sql = HEARTBEAT if record.get("kind") == "heartbeat" else INSERT
        while True:
            try:
                await conn.execute(sql, record)
                break
            except psycopg.OperationalError as e:
                log.warning("insert failed (%s); reconnecting", e)
                await conn.close()
                conn = await _connect(url)
            except psycopg.Error as e:
                log.error("skipped a %s record the database refused: %s",
                          record.get("kind", "reading"), e)
                break
