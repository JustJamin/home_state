"""Decode home_state advertising payloads (see the repo README for the format).

BlueZ/bleak hand over manufacturer data as {company_id: bytes}, with the
company ID already stripped, so offsets here are 2 less than in the README.
"""

import struct
from dataclasses import dataclass

COMPANY_ID = 0xFFFF

# version, board_id, counter, temp_c_x100, uptime_s
_V1 = struct.Struct("<BBHhH")


@dataclass(frozen=True)
class Reading:
    version: int
    board_id: int
    counter: int
    temp_c: float
    uptime_s: int


def decode(data: bytes) -> Reading | None:
    """Decode the bytes after the company ID; None if not a known format."""
    if len(data) < 1 or data[0] != 1 or len(data) < _V1.size:
        return None
    version, board_id, counter, temp_c_x100, uptime_s = _V1.unpack_from(data)
    return Reading(version, board_id, counter, temp_c_x100 / 100, uptime_s)
