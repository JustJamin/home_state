"""Power-cycle the Bluetooth adapter over BlueZ's D-Bus API, as `bluetoothctl power off`
then `power on` would.

Why: on 2026-10-15 lenovo's AR3012 came back from a long USB suspend powered but deaf. It
heard nothing until its controller was powered off and on, so restarting the scanner alone
just crash-looped. The scanner now does this before it exits on a stall. BlueZ's D-Bus
policy lets any user send to org.bluez, so uid 65534 (nobody) can do it.
"""

import asyncio
import logging

log = logging.getLogger("adapter")

ADAPTER1 = "org.bluez.Adapter1"


async def power_cycle(props, *, off_s: float = 2, wait_s: float = 10, sleep=asyncio.sleep) -> bool:
    """Using an org.freedesktop.DBus.Properties proxy for the adapter: Powered off, wait,
    on, then wait until it reports powered. Returns True once it's back on."""
    from dbus_fast import Variant
    await props.call_set(ADAPTER1, "Powered", Variant("b", False))
    await sleep(off_s)
    await props.call_set(ADAPTER1, "Powered", Variant("b", True))
    for _ in range(int(wait_s / 0.5)):
        if (await props.call_get(ADAPTER1, "Powered")).value:
            return True
        await sleep(0.5)
    return False


async def reset(adapter: str = "hci0") -> bool:
    """Power-cycle /org/bluez/<adapter>. Never raises: returns whether it worked."""
    from dbus_fast import BusType
    from dbus_fast.aio import MessageBus
    bus = None
    try:
        bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        path = f"/org/bluez/{adapter}"
        obj = bus.get_proxy_object("org.bluez", path, await bus.introspect("org.bluez", path))
        ok = await asyncio.wait_for(power_cycle(obj.get_interface("org.freedesktop.DBus.Properties")), 30)
        log.warning("power-cycled Bluetooth adapter %s: %s", adapter, "back on" if ok else "NOT back on")
        return ok
    except Exception as e:
        log.error("couldn't power-cycle Bluetooth adapter %s: %r", adapter, e)
        return False
    finally:
        if bus:
            bus.disconnect()
