"""Provisioning API: firmware catalogue, config/profile/deployment sync, fleet view.

Catalogue (read-only, from disk; written by firmware/release.sh):
    firmware/<app>/<version>/{firmware.bin, default.config.json, methods.json}

Store (Postgres schema `provisioning`, role `provisioning`: SELECT + INSERT only):
    configs, profiles, deployments, archives. Every record has a client-made
    UUID and is immutable, so the phone's offline outbox can be POSTed again
    safely and sync never conflicts. One sequence orders all of them:
    GET /api/sync?since=N returns everything with seq > N.
"""

import hashlib
import json
import os
import re
import struct
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, Field

from scripts import validate_script

FIRMWARE_DIR = Path(os.environ.get("FIRMWARE_DIR", Path(__file__).parent / "firmware"))
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")
FILES = {"firmware.bin": "application/octet-stream",
         "default.config.json": "application/json",
         "methods.json": "application/json"}
SYNC_OVERLAP = 50  # re-send a few seqs before the cursor: covers transactions that committed out of order

router = APIRouter()

_url = os.environ.get("PROVISIONING_DATABASE_URL")
pool = AsyncConnectionPool(_url, min_size=1, max_size=4, open=False,
                           kwargs={"row_factory": dict_row}) if _url else None


# ---------------- catalogue ----------------

def image_meta(img: bytes) -> dict | None:
    """Metadata from an ESP-IDF app image: esp_app_desc_t sits at offset 32."""
    if len(img) < 32 + 176 or img[0] != 0xE9 or struct.unpack_from("<I", img, 32)[0] != 0xABCD5432:
        return None
    field = lambda off, n: img[32 + off: 32 + off + n].split(b"\0")[0].decode(errors="replace")
    built = " ".join(field(96, 16).split()) + " " + field(80, 16)
    try:
        built = datetime.strptime(built, "%b %d %Y %H:%M:%S").isoformat()
    except ValueError:
        pass
    return {"project": field(48, 32), "version": field(16, 32), "idf": field(112, 32), "built": built,
            "size": len(img), "sha256": hashlib.sha256(img).hexdigest()}


def catalogue() -> dict[str, dict[str, dict]]:
    """{app: {version: entry}}; only entries whose image header matches its directory."""
    apps: dict[str, dict[str, dict]] = {}
    for fw in FIRMWARE_DIR.glob("*/*/firmware.bin"):
        app, version = fw.parent.parent.name, fw.parent.name
        if not (NAME.match(app) and NAME.match(version)):
            continue
        meta = image_meta(fw.read_bytes())
        if not meta or meta["project"] != app or meta["version"] != version:
            continue
        d = fw.parent
        meta["configurable"] = (d / "methods.json").exists() and (d / "default.config.json").exists()
        apps.setdefault(app, {})[version] = meta
    return apps


def rf_stack_errors(rf_stack: str | None, methods: dict) -> list[str]:
    """A profile's radio stack must be one its firmware version declares (or none if it declares none)."""
    rf = methods.get("rf_stacks")
    if not rf:
        return [] if rf_stack is None else ["this firmware version declares no radio stack versions"]
    if rf_stack not in rf.get("versions", []):
        return [f"radio stack must be one of {', '.join(rf['versions'])}"]
    return []


def methods_for(app: str, version: str) -> dict | None:
    entry = catalogue().get(app, {}).get(version)
    if not entry or not entry["configurable"]:
        return None
    return json.loads((FIRMWARE_DIR / app / version / "methods.json").read_text())


@router.get("/api/apps")
async def apps() -> list[dict]:
    out = []
    for app, versions in sorted(catalogue().items()):
        vs = sorted(versions.values(), key=lambda m: m["built"], reverse=True)
        out.append({"app": app, "versions": [{k: v for k, v in m.items() if k != "project"} for m in vs]})
    return out


@router.get("/api/apps/{app}/{version}/{file}")
async def app_file(app: str, version: str, file: str) -> FileResponse:
    if file not in FILES or version not in catalogue().get(app, {}):
        raise HTTPException(404, "not in catalogue")
    path = FIRMWARE_DIR / app / version / file
    if not path.exists():
        raise HTTPException(404, f"{app} {version} has no {file}")
    # released versions never change
    return FileResponse(path, media_type=FILES[file], headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ---------------- store ----------------

class Config(BaseModel):
    id: uuid.UUID
    app: str
    version: str
    name: str = Field(min_length=1, max_length=80)
    script: dict
    created_at: datetime
    client: str | None = None


class Profile(BaseModel):
    id: uuid.UUID
    name: str = Field(min_length=1, max_length=80)
    app: str
    version: str
    config_id: uuid.UUID | None = None
    config_name: str
    script: dict
    rf_stack: str | None = None  # radio stack version; must be one the firmware version declares
    created_at: datetime
    client: str | None = None


class Deployment(BaseModel):
    id: uuid.UUID
    device_id: str = Field(pattern=r"^[0-9a-f]{12}$")
    board_id: int | None = None
    profile_id: uuid.UUID | None = None
    profile_name: str | None = None
    app: str
    version: str
    from_version: str | None = None
    rf_stack: str | None = None
    ble_address: str | None = Field(None, pattern=r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")
    flashed: bool
    script: dict
    results: list
    ok: bool
    error: str | None = None
    started_at: datetime
    finished_at: datetime
    client: str | None = None


class Archive(BaseModel):
    id: uuid.UUID
    kind: str = Field(pattern="^(config|profile)$")
    record_id: uuid.UUID
    archived_at: datetime
    client: str | None = None


class SyncPush(BaseModel):
    configs: list[Config] = []
    profiles: list[Profile] = []
    deployments: list[Deployment] = []
    archives: list[Archive] = []


TABLES = {"configs": Config, "profiles": Profile, "deployments": Deployment, "archives": Archive}


def need_pool() -> AsyncConnectionPool:
    if pool is None:
        raise HTTPException(503, "provisioning store not configured (PROVISIONING_DATABASE_URL)")
    return pool


def to_api(row: dict) -> dict:
    return {k: (v.isoformat() if isinstance(v, datetime) else str(v) if isinstance(v, uuid.UUID) else v)
            for k, v in row.items()}


@router.get("/api/sync")
async def sync_pull(since: int = Query(0, ge=0)) -> dict:
    """Everything with seq > since (minus a small overlap; the phone dedupes by id)."""
    from_seq = max(0, since - SYNC_OVERLAP)
    out: dict = {}
    async with need_pool().connection() as conn:
        seq = 0
        for table in TABLES:
            rows = await (await conn.execute(
                f"SELECT * FROM provisioning.{table} WHERE seq > %s ORDER BY seq", (from_seq,))).fetchall()
            out[table] = [to_api(r) for r in rows]
            seq = max([seq] + [r["seq"] for r in rows])
        out["seq"] = max(seq, since)
    return out


@router.post("/api/sync")
async def sync_push(body: SyncPush) -> dict:
    """Insert records the server doesn't have yet. Idempotent: re-sending a record is a no-op.
    Configs and profiles must validate against their version's methods.json; deployments
    are facts and are always stored."""
    accepted: dict[str, list[str]] = {t: [] for t in TABLES}
    rejected: list[dict] = []
    async with need_pool().connection() as conn:
        async with conn.transaction():
            for table, model in TABLES.items():
                for rec in getattr(body, table):
                    if table in ("configs", "profiles"):
                        methods = methods_for(rec.app, rec.version)
                        errors = (["unknown or non-configurable firmware version"] if methods is None
                                  else validate_script(rec.script, methods, shared=True))
                        if methods is not None and table == "profiles":
                            errors += rf_stack_errors(rec.rf_stack, methods)
                        if errors:
                            rejected.append({"table": table, "id": str(rec.id), "errors": errors})
                            continue
                    data = rec.model_dump()
                    cols = list(data)
                    vals = [Jsonb(v) if isinstance(v, (dict, list)) else v for v in data.values()]
                    await conn.execute(
                        f"INSERT INTO provisioning.{table} ({', '.join(cols)}) "
                        f"VALUES ({', '.join(['%s'] * len(cols))}) ON CONFLICT (id) DO NOTHING", vals)
                    accepted[table].append(str(rec.id))
    return {"accepted": accepted, "rejected": rejected}


@router.get("/api/fleet")
async def fleet() -> list[dict]:
    """One row per device: its latest deployment and how many it has had."""
    async with need_pool().connection() as conn:
        rows = await (await conn.execute("""
            SELECT DISTINCT ON (device_id) device_id, board_id, ble_address, profile_id, profile_name, app,
                   version, rf_stack, ok, error, finished_at, flashed,
                   count(*) OVER (PARTITION BY device_id) AS deployments
            FROM provisioning.deployments
            ORDER BY device_id, finished_at DESC""")).fetchall()
    return [to_api(r) for r in rows]
