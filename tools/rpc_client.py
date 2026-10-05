#!/usr/bin/env python3
"""JSON-RPC client for home_state nodes, over USB serial or BLE (docs/jsonrpc.md).

    tools/.venv/bin/python tools/rpc_client.py --serial /dev/ttyACM0 device.info
    tools/.venv/bin/python tools/rpc_client.py --ble hs-01 config.set '{"led":{"blink_hz":4}}'
    tools/.venv/bin/python tools/rpc_client.py --serial /dev/ttyACM0 --script firmware/apps/single-blink/default.json

Setup: python3 -m venv tools/.venv && tools/.venv/bin/pip install -r tools/requirements.txt
"""

import argparse
import asyncio
import json
import sys
import time

RPC_UUID = "2727b004-1ada-46ff-8cde-9e8f32a32c1a"
F_FINAL, F_START = 0x01, 0x02


class SerialTransport:
    def __init__(self, port: str):
        import serial
        # Leave DTR/RTS as the kernel sets them on open (both asserted). Changing them,
        # even to False, passes through DTR=0/RTS=1, which the ESP32's USB-Serial-JTAG
        # treats as "reset the chip" (that's how esptool resets it).
        self.s = serial.Serial(port, 115200, timeout=0.2)
        self.s.reset_input_buffer()

    async def call(self, req: dict, timeout: float = 5) -> dict:
        self.s.write((json.dumps(req, separators=(",", ":")) + "\n").encode())
        deadline = time.monotonic() + timeout
        buf = b""
        while time.monotonic() < deadline:
            buf += self.s.read(4096)
            *lines, buf = buf.split(b"\n")
            for line in lines:
                line = line.strip()
                if not line.startswith(b"{") or b'"jsonrpc"' not in line:
                    continue  # a log line
                resp = json.loads(line)
                if resp.get("id") == req.get("id"):
                    return resp
            await asyncio.sleep(0.01)
        raise TimeoutError(f"no response to {req['method']}")

    async def close(self):
        self.s.close()


class BleTransport:
    def __init__(self, name: str):
        self.name = name
        self.queue: asyncio.Queue = asyncio.Queue()
        self.partial = b""

    async def open(self):
        from bleak import BleakClient, BleakScanner
        dev = await BleakScanner.find_device_by_name(self.name, timeout=20)
        if dev is None:
            raise RuntimeError(f"{self.name} not found")
        self.client = BleakClient(dev, timeout=20)
        await self.client.connect()
        await self.client.start_notify(RPC_UUID, self._on_notify)
        # largest write that fits one ATT packet (BlueZ negotiates up to 517)
        self.frag = min(self.client.mtu_size, 517) - 3 - 1
        return self

    def _on_notify(self, _, data: bytearray):
        flags, body = data[0], bytes(data[1:])
        if flags & F_START:
            self.partial = b""
        self.partial += body
        if flags & F_FINAL:
            self.queue.put_nowait(self.partial)
            self.partial = b""

    async def call(self, req: dict, timeout: float = 10) -> dict:
        msg = json.dumps(req, separators=(",", ":")).encode()
        for off in range(0, max(len(msg), 1), self.frag):
            part = msg[off: off + self.frag]
            flags = (F_START if off == 0 else 0) | (F_FINAL if off + self.frag >= len(msg) else 0)
            await self.client.write_gatt_char(RPC_UUID, bytes([flags]) + part, response=True)
        while True:
            resp = json.loads(await asyncio.wait_for(self.queue.get(), timeout))
            if resp.get("id") == req.get("id"):
                return resp

    async def close(self):
        await self.client.disconnect()


async def run(args) -> int:
    t = SerialTransport(args.serial) if args.serial else await BleTransport(args.ble).open()
    try:
        if args.script:
            script = json.load(open(args.script))
            calls = script["calls"] if isinstance(script, dict) else script
        else:
            params = json.loads(args.params) if args.params else None
            calls = [{"method": args.method, **({"params": params} if params is not None else {})}]
        failed = 0
        for i, c in enumerate(calls, 1):
            req = {"jsonrpc": "2.0", "id": i, "method": c["method"]}
            if "params" in c:
                req["params"] = c["params"]
            resp = await t.call(req)
            if args.raw:
                print(json.dumps(resp))
            elif "error" in resp:
                failed += 1
                print(f"{c['method']}: ERROR {json.dumps(resp['error'])}")
            else:
                print(f"{c['method']}: {json.dumps(resp['result'], indent=2)}")
            if "error" in resp and args.script:
                break  # scripts stop at the first error
        return 1 if failed else 0
    finally:
        await t.close()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--serial", metavar="PORT")
    g.add_argument("--ble", metavar="NAME")
    p.add_argument("--script", help="run a config script ({'calls': [...]}) in order")
    p.add_argument("--raw", action="store_true", help="print full JSON-RPC responses")
    p.add_argument("method", nargs="?")
    p.add_argument("params", nargs="?", help="JSON params")
    args = p.parse_args()
    if not args.script and not args.method:
        p.error("give a method or --script")
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
