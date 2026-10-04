import unittest

from payload import decode


class DecodeTest(unittest.TestCase):
    def test_v1(self):
        # captured from hs-01 via bluetoothctl: counter 15, 21.50 C, uptime 75 s
        r = decode(bytes.fromhex("01010f0066084b00"))
        self.assertEqual((r.version, r.board_id, r.counter, r.temp_c, r.uptime_s), (1, 1, 15, 21.5, 75))

    def test_negative_temp(self):
        r = decode(bytes.fromhex("010102000cfe0000"))
        self.assertEqual(r.temp_c, -5.0)

    def test_rejects_unknown_or_short(self):
        self.assertIsNone(decode(b""))
        self.assertIsNone(decode(bytes.fromhex("02010f0066084b00")))
        self.assertIsNone(decode(bytes.fromhex("01010f00")))


if __name__ == "__main__":
    unittest.main()
