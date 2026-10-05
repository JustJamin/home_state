#!/usr/bin/env python3
"""Bench client for the home_state BLE OTA protocol v1 (docs/ota-protocol.md).

Runs on lenovo with bleak (use scanner/.venv). It speaks the same protocol
as the phone's provisioning page, so the firmware can be tested without
the UI. Fault injection flags exercise the node's error paths.

    scanner/.venv/bin/python tools/ota_client.py info
    scanner/.venv/bin/python tools/ota_client.py flash firmware/build/hs_advertiser.bin
    ... flash IMAGE --bad-hash | --truncate N | --drop-chunk N | --disconnect-at BYTES | --with-response
"""

import argparse
import asyncio
import hashlib
import json
import struct
import sys
import time

from bleak import BleakClient, BleakScanner

BASE = "2727b0{:02x}-1ada-46ff-8cde-9e8f32a32c1a"
SVC, INFO, CTRL, DATA = (BASE.format(i) for i in range(4))

CMD_BEGIN, CMD_END, CMD_APPLY, CMD_ABORT, CMD_SYNC = 1, 2, 3, 4, 5
RSP_BEGIN, RSP_END, RSP_APPLY, RSP_ABORT, RSP_SYNC, RSP_NAK = 0x81, 0x82, 0x83, 0x84, 0x85, 0x91
STATUS = {0: "OK", 1: "BAD_STATE", 2: "TOO_BIG", 3: "FLASH", 4: "BAD_OFFSET", 5: "HASH",
          6: "IMAGE_INVALID", 7: "WRONG_PROJECT", 8: "BAD_CMD"}


class OtaError(Exception):
    pass


def image_info(img: bytes) -> dict:
    """Read project/version from an ESP-IDF app image (esp_app_desc_t at offset 32)."""
    if len(img) < 112 or img[0] != 0xE9:
        raise OtaError("not an ESP-IDF app image (bad magic)")
    magic, = struct.unpack_from("<I", img, 32)
    if magic != 0xABCD5432:
        raise OtaError("no app description in image")
    version = img[48:80].split(b"\0")[0].decode()
    project = img[80:112].split(b"\0")[0].decode()
    return {"project": project, "version": version, "size": len(img),
            "sha256": hashlib.sha256(img).hexdigest()}


async def find(name: str, timeout: float = 20):
    dev = await BleakScanner.find_device_by_name(name, timeout=timeout)
    if dev is None:
        raise OtaError(f"{name} not found")
    return dev


class Node:
    def __init__(self, client: BleakClient):
        self.c = client
        self.replies: asyncio.Queue = asyncio.Queue()

    async def start(self):
        await self.c.start_notify(CTRL, lambda _, d: self.replies.put_nowait(bytes(d)))

    async def info(self) -> dict:
        return json.loads(bytes(await self.c.read_gatt_char(INFO)))

    async def expect(self, rtype: int, timeout: float = 10) -> bytes:
        while True:
            r = await asyncio.wait_for(self.replies.get(), timeout)
            if r[0] == rtype:
                if r[1] != 0:
                    raise OtaError(f"reply 0x{rtype:02x}: {STATUS.get(r[1], r[1])}")
                return r[2:]
            if r[0] == RSP_NAK:  # node aborted the transfer
                raise OtaError(f"NAK: {STATUS.get(r[1], r[1])}")

    def check_nak(self):
        """Raise if the node sent a fatal NAK since we last looked."""
        while not self.replies.empty():
            r = self.replies.get_nowait()
            if r[0] == RSP_NAK:
                raise OtaError(f"NAK: {STATUS.get(r[1], r[1])}")

    async def sync(self) -> int:
        """Ask the node how many bytes it has accepted; resume from there."""
        self.check_nak()
        await self.cmd(bytes([CMD_SYNC]))
        received, = struct.unpack("<I", await self.expect(RSP_SYNC))
        return received

    async def cmd(self, payload: bytes):
        await self.c.write_gatt_char(CTRL, payload, response=True)


async def flash(args) -> None:
    img = open(args.image, "rb").read()
    meta = image_info(img)
    declared_sha = bytes.fromhex(meta["sha256"])
    if args.bad_hash:
        declared_sha = bytes(32)
    send = img[: args.truncate] if args.truncate else img
    print(f"image: {meta['project']} {meta['version']}, {len(img)} bytes, sha256 {meta['sha256'][:16]}…")

    dev = await find(args.name)
    async with BleakClient(dev, timeout=20) as c:
        node = Node(c)
        await node.start()
        before = await node.info()
        print(f"node: {before['proj']} {before['fw']} in {before['part']} ({before['state']}), mtu {before['mtu']}")

        await node.cmd(struct.pack("<BI", CMD_BEGIN, len(img)) + declared_sha)
        chunk, window = struct.unpack("<HH", await node.expect(RSP_BEGIN))
        print(f"BEGIN ok: chunk {chunk} B, window {window}")

        t0, offset, dropped = time.monotonic(), 0, False
        while offset < len(send):
            # burst of `window` chunks without response, then SYNC
            for _ in range(window):
                if offset >= len(send):
                    break
                if args.disconnect_at and offset >= args.disconnect_at:
                    print(f"\ndisconnecting at {offset} bytes (test)")
                    await c.disconnect()
                    return
                data = send[offset: offset + chunk]
                if args.drop_chunk is not None and offset // chunk == args.drop_chunk and not dropped:
                    dropped = True
                    print(f"\ndropping chunk {args.drop_chunk} (test)")
                else:
                    await c.write_gatt_char(DATA, struct.pack("<I", offset) + data, response=args.with_response)
                offset += len(data)
            received = await node.sync()
            if received != offset:
                print(f"\nnode has {received}, we sent up to {offset}: resending from {received}")
            offset = received
            if len(send) < len(img) and offset >= len(send):
                break  # truncation test
            el = time.monotonic() - t0
            print(f"\r  {offset}/{len(img)} bytes  {offset / el / 1024:.1f} KB/s", end="", flush=True)
        el = time.monotonic() - t0
        print(f"\nsent {len(send)} bytes in {el:.1f} s ({len(send) / el / 1024:.1f} KB/s)")

        await node.cmd(bytes([CMD_END]))
        await node.expect(RSP_END, timeout=20)
        print("END ok: node verified sha256 and image")
        if args.no_apply:
            return
        await node.cmd(bytes([CMD_APPLY]))
        await node.expect(RSP_APPLY)
        print("APPLY ok: node rebooting")

    # reconnect and confirm the new image is running
    target = meta["version"]
    for attempt in range(30):
        await asyncio.sleep(2)
        try:
            dev = await find(args.name, timeout=5)
            async with BleakClient(dev, timeout=15) as c:
                after = await Node(c).info()
        except Exception:
            continue
        print(f"after reboot: {after['fw']} in {after['part']} ({after['state']}), "
              f"rolled_back_from={after['rolled_back_from']}")
        if after["fw"] == target:
            print("SUCCESS" if after["state"] == "valid" else "running new image, still pending verify")
        else:
            print(f"NOT RUNNING TARGET: expected {target}")
        return
    raise OtaError("node did not come back within 60 s")


async def info(args) -> None:
    dev = await find(args.name)
    async with BleakClient(dev, timeout=20) as c:
        print(json.dumps(await Node(c).info(), indent=2))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", default="hs-01")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info")
    f = sub.add_parser("flash")
    f.add_argument("image")
    f.add_argument("--with-response", action="store_true", help="write every chunk with response (fallback mode)")
    f.add_argument("--no-apply", action="store_true", help="stop after END")
    f.add_argument("--bad-hash", action="store_true", help="declare a wrong sha256 (expect HASH)")
    f.add_argument("--truncate", type=int, metavar="N", help="send only the first N bytes (expect END BAD_STATE)")
    f.add_argument("--drop-chunk", type=int, metavar="N", help="skip chunk N once (expect NAK + resend)")
    f.add_argument("--disconnect-at", type=int, metavar="BYTES", help="disconnect mid-transfer (expect abort)")
    args = p.parse_args()
    try:
        asyncio.run(info(args) if args.cmd == "info" else flash(args))
    except (OtaError, TimeoutError) as e:
        print(f"\nFAILED: {e or type(e).__name__}")
        sys.exit(1)


if __name__ == "__main__":
    main()
