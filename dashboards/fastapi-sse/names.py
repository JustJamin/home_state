"""Device names: labels people give devices in the fleet ("rack-3-top"), shown instead of
hs-02 on the dashboard, in Admin and in alerts. The device itself doesn't know its name.

Stored append-only in provisioning.device_names (latest row per device wins; name NULL =
cleared). A name must be unique in the fleet, ignoring capitals; renaming needs the
server (that's where uniqueness is decided). Readings are matched to devices by BLE
address: on the ESP32-C6 the BT MAC is the factory MAC (the device ID) + 2.
"""

import re
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,20}$")
DEVICE_RE = re.compile(r"^[0-9a-f]{12}$")

router = APIRouter()
pool = None                      # provisioning pool (set by app.py at startup)
current: dict[str, str] = {}     # device_id -> name (only devices that have one)


def device_id_for(address: str) -> str | None:
    """BLE address (58:E6:C5:19:50:8A) -> device ID (58e6c5195088): BT MAC = factory MAC + 2."""
    try:
        return format((int(address.replace(":", ""), 16) - 2) & 0xFFFFFFFFFFFF, "012x")
    except (ValueError, AttributeError):
        return None


def label(address: str | None, board: str) -> str:
    """What to call a board's readings: its fleet name, else hs-NN."""
    return current.get(device_id_for(address) or "", board) if address else board


async def load() -> None:
    if not pool:
        return
    async with pool.connection() as conn:
        rows = await (await conn.execute("""
            SELECT DISTINCT ON (device_id) device_id, name FROM provisioning.device_names
            ORDER BY device_id, seq DESC""")).fetchall()
    current.clear()
    current.update({r["device_id"]: r["name"] for r in rows if r["name"]})


@router.get("/api/devices/names")
async def names() -> list[dict]:
    if not pool:
        return []
    async with pool.connection() as conn:
        rows = await (await conn.execute("""
            SELECT DISTINCT ON (device_id) device_id, name, changed_at FROM provisioning.device_names
            ORDER BY device_id, seq DESC""")).fetchall()
    return [{"device_id": r["device_id"], "name": r["name"], "changed_at": r["changed_at"].isoformat()}
            for r in rows if r["name"]]


class Rename(BaseModel):
    name: str | None = Field(None, max_length=20)  # None or "" clears the name
    client: str | None = None


@router.post("/api/devices/{device_id}/name")
async def rename(device_id: str, body: Rename) -> dict:
    if not DEVICE_RE.match(device_id):
        raise HTTPException(422, "device ID must be 12 lowercase hex digits")
    name = (body.name or "").strip() or None
    if name is not None and not NAME_RE.match(name):
        raise HTTPException(422, "names are 1-20 characters: letters, numbers, '.', '-' and '_'")
    if not pool:
        raise HTTPException(503, "device names store not configured")
    async with pool.connection() as conn:
        async with conn.transaction():
            # one rename at a time, so two devices can't grab the same name concurrently
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext('home_state.device_names'))")
            rows = await (await conn.execute("""
                SELECT DISTINCT ON (device_id) device_id, name FROM provisioning.device_names
                ORDER BY device_id, seq DESC""")).fetchall()
            if name is not None:
                clash = next((r["device_id"] for r in rows
                              if r["name"] and r["device_id"] != device_id and r["name"].lower() == name.lower()), None)
                if clash:
                    raise HTTPException(409, f"'{name}' is already the name of device {clash}")
            await conn.execute(
                "INSERT INTO provisioning.device_names (id, device_id, name, client) VALUES (%s, %s, %s, %s)",
                (uuid.uuid4(), device_id, name, body.client))
    if name:
        current[device_id] = name
    else:
        current.pop(device_id, None)
    return {"device_id": device_id, "name": name}
