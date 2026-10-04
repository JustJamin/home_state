"""Write readings to Postgres, reconnecting if the database goes away."""

import asyncio
import logging

import psycopg

log = logging.getLogger("db")

INSERT = """
    INSERT INTO readings (received_at, board_id, address, name, rssi, version, counter, temp_c, uptime_s)
    VALUES (%(ts)s, %(board_id)s, %(address)s, %(name)s, %(rssi)s, %(version)s, %(counter)s, %(temp_c)s, %(uptime_s)s)
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
    """Insert each record from the queue; a record is retried until it lands."""
    conn = await _connect(url)
    while True:
        record = await queue.get()
        while True:
            try:
                await conn.execute(INSERT, record)
                break
            except psycopg.OperationalError as e:
                log.warning("insert failed (%s); reconnecting", e)
                await conn.close()
                conn = await _connect(url)
