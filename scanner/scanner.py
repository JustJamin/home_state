"""Listen for home_state boards over BLE and print each new reading as JSON."""

import asyncio
import json
import logging
import signal
from dataclasses import asdict
from datetime import datetime, timezone

from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

from payload import COMPANY_ID, decode

log = logging.getLogger("scanner")

# board_id -> last counter seen; adverts repeat ~5x per counter value
_last_counter: dict[int, int] = {}


def on_advert(device: BLEDevice, adv: AdvertisementData) -> None:
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


async def main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    async with BleakScanner(on_advert):
        log.info("scanning for company ID 0x%04X", COMPANY_ID)
        await stop.wait()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main())
