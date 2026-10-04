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

# board_id -> last counter seen; adverts repeat ~5x per counter value
_last_counter: dict[int, int] = {}
_last_advert = time.monotonic()


def make_callback(queue: asyncio.Queue | None):
    def on_advert(device: BLEDevice, adv: AdvertisementData) -> None:
        global _last_advert
        _last_advert = time.monotonic()

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

    stalled = False
    async with BleakScanner(make_callback(queue)):
        log.info("scanning for company ID 0x%04X", COMPANY_ID)
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=10)
            except TimeoutError:
                silent = time.monotonic() - _last_advert
                if silent > STALL_SECONDS:
                    log.error("no BLE adverts for %.0fs; scanning has stalled, exiting", silent)
                    stalled = True
                    break

    if writer_task is not None:
        writer_task.cancel()
    if stalled:
        raise SystemExit(1)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main())
