import asyncio
import unittest

from adapter import power_cycle


class FakeProps:
    """org.freedesktop.DBus.Properties for an adapter that takes `lag` polls to come back."""

    def __init__(self, lag=0, comes_back=True):
        self.powered, self.calls, self.lag, self.comes_back = True, [], lag, comes_back

    async def call_set(self, iface, name, v):
        self.calls.append((iface, name, v.value))
        self.powered = v.value and self.comes_back

    async def call_get(self, iface, name):
        if self.lag:
            self.lag -= 1
            return type("V", (), {"value": False})
        return type("V", (), {"value": self.powered})


async def no_sleep(_):
    pass


class PowerCycleTest(unittest.TestCase):
    def test_off_then_on(self):
        p = FakeProps(lag=2)
        self.assertTrue(asyncio.run(power_cycle(p, sleep=no_sleep)))
        self.assertEqual(p.calls, [("org.bluez.Adapter1", "Powered", False), ("org.bluez.Adapter1", "Powered", True)])

    def test_reports_an_adapter_that_stays_off(self):
        self.assertFalse(asyncio.run(power_cycle(FakeProps(comes_back=False), sleep=no_sleep)))


if __name__ == "__main__":
    unittest.main()
