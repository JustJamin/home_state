"""Listen for home_state boards over BLE, print each new reading as JSON and,
if DATABASE_URL is set, store it in Postgres."""

import asyncio
import json
import logging
import os
import signal
import time
from dataclasses import asdict
from datetime import datetime, timezone

from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

from payload import COMPANY_ID, decode

log = logging.getLogger("scanner")

# If no BLE advert at all (from any device) arrives for this long, assume
# scanning has silently died (e.g. the adapter re-enumerated on USB and BlueZ
# dropped our discovery session) and exit so the container gets restarted.
STALL_SECONDS = int(os.environ.get("STALL_SECONDS", "120"))
# ...and first power-cycle the adapter (adapter.py): an adapter that has gone deaf can stay
# deaf across scanner restarts until its controller is powered off and on.
RESET_ADAPTER = os.environ.get("RESET_ADAPTER", "1") == "1"
BLE_ADAPTER = os.environ.get("BLE_ADAPTER", "hci0")

# Every HEARTBEAT_SECONDS the scanner records how much it heard (scanner_heartbeat, read by
# the Server Temp app's health checks): adverts from ANY device show the adapter is alive
# even when no board is in range, and zero means the adapter has gone deaf.
HEARTBEAT_SECONDS = int(os.environ.get("HEARTBEAT_SECONDS", "30"))

# board_id -> last counter seen; adverts repeat ~5x per counter value
_last_counter: dict[int, int] = {}
_last_advert = time.monotonic()
_heard = {"adverts": 0, "readings": 0}  # since the last heartbeat


def make_callback(queue: asyncio.Queue | None):
    def on_advert(device: BLEDevice, adv: AdvertisementData) -> None:
        global _last_advert
        _last_advert = time.monotonic()
        _heard["adverts"] += 1

        data = adv.manufacturer_data.get(COMPANY_ID)
        if data is None:
            return
        reading = decode(data)
        if reading is None:
            log.warning("unknown payload from %s: %s", device.address, data.hex())
            return
        if _last_counter.get(reading.board_id) == reading.counter:
            return
        _last_counter[reading.board_id] = reading.counter
        _heard["readings"] += 1

        record = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "address": device.address,
            "name": adv.local_name,
            "rssi": adv.rssi,
            **asdict(reading),
        }
        print(json.dumps(record), flush=True)
        if queue is not None:
            queue.put_nowait(record)

    return on_advert


async def main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    queue = None
    writer_task = None
    if url := os.environ.get("DATABASE_URL"):
        from db import writer

        queue = asyncio.Queue()
        writer_task = asyncio.create_task(writer(url, queue))

    started_at = datetime.now(timezone.utc)
    window_start = time.monotonic()

    def heartbeat() -> None:
        nonlocal window_start
        now = time.monotonic()
        record = {"kind": "heartbeat", "started_at": started_at, "window_s": round(now - window_start, 1),
                  "adverts": _heard["adverts"], "readings": _heard["readings"],
                  "last_advert_s": round(now - _last_advert, 1)}
        _heard.update(adverts=0, readings=0)
        window_start = now
        if queue is not None:
            queue.put_nowait(record)

    stalled = deaf = False
    async with BleakScanner(make_callback(queue), bluez={"adapter": BLE_ADAPTER}):
        log.info("scanning for company ID 0x%04X", COMPANY_ID)
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=10)
            except TimeoutError:
                if time.monotonic() - window_start >= HEARTBEAT_SECONDS:
                    heartbeat()
                silent = time.monotonic() - _last_advert
                if writer_task is not None and writer_task.done():
                    log.error("database writer stopped (%r), exiting", writer_task.exception())
                    stalled = True
                    break
                if silent > STALL_SECONDS:
                    log.error("no BLE adverts for %.0fs; scanning has stalled, exiting", silent)
                    heartbeat()  # record the deaf window before the restart
                    await asyncio.sleep(1)  # let the writer store it
                    stalled = deaf = True
                    break

    if writer_task is not None:
        writer_task.cancel()
    if deaf and RESET_ADAPTER:
        import adapter
        await adapter.reset(BLE_ADAPTER)  # after leaving the scanner, so the restart starts clean
    if stalled:
        raise SystemExit(1)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main())
