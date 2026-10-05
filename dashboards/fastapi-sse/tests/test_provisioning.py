"""Catalogue, script validation, sync and fleet tests.

Needs a throwaway Postgres with deploy/initdb applied (tests/run.sh sets this up):
    TEST_PG_URL=postgresql://home_state:test@127.0.0.1:55432/home_state
"""

import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

HERE = Path(__file__).parent
REPO = HERE.parents[2]
PG = os.environ.get("TEST_PG_URL")
os.environ.setdefault("DATABASE_URL", PG or "postgresql://unused")
if PG:
    os.environ["PROVISIONING_DATABASE_URL"] = PG.replace("home_state:test@", "provisioning:test@")

import sys  # noqa: E402
sys.path.insert(0, str(HERE.parent))
import scripts  # noqa: E402

IMAGE = Path(os.environ.get("FW_IMAGE", REPO / "firmware/build/hs_advertiser.bin"))
METHODS = json.loads((REPO / "firmware/config/methods.json").read_text())
now = lambda: datetime.now(timezone.utc).isoformat()


def image_version(img: bytes) -> str:
    return img[48:80].split(b"\0")[0].decode()


# ---------------- script validation (shared vectors with schema.js) ----------------

@pytest.mark.parametrize("case", json.loads((HERE / "script_vectors.json").read_text())["cases"], ids=lambda c: c["name"])
def test_script_vectors(case):
    assert scripts.validate_script(case["script"], METHODS, case["shared"]) == case["errors"]


def test_default_config_is_valid():
    default = json.loads((REPO / "firmware/config/default.json").read_text())
    assert scripts.validate_script(default, METHODS) == []


# ---------------- catalogue ----------------

@pytest.fixture(scope="module")
def client(tmp_path_factory):
    """One app (and one lifespan) for the module: psycopg pools can't be reopened once closed."""
    tmp_path = tmp_path_factory.mktemp("catalogue")
    if not IMAGE.exists():
        pytest.skip(f"no firmware image at {IMAGE}")
    img = IMAGE.read_bytes()
    ver = image_version(img)
    good = tmp_path / "hs_advertiser" / ver
    good.mkdir(parents=True)
    shutil.copy(IMAGE, good / "firmware.bin")
    shutil.copy(REPO / "firmware/config/default.json", good / "default.config.json")
    shutil.copy(REPO / "firmware/config/methods.json", good / "methods.json")
    # a version directory whose image says something else: must be ignored
    wrong = tmp_path / "hs_advertiser" / "v9.9.9"
    wrong.mkdir()
    shutil.copy(IMAGE, wrong / "firmware.bin")
    (tmp_path / "secret.txt").write_text("nope")

    import provisioning
    import app as appmod
    from fastapi.testclient import TestClient
    saved, provisioning.FIRMWARE_DIR = provisioning.FIRMWARE_DIR, tmp_path
    try:
        if PG:
            with TestClient(appmod.app) as c:  # runs lifespan: opens both pools
                yield c, ver
        else:
            yield TestClient(appmod.app), ver
    finally:
        provisioning.FIRMWARE_DIR = saved


def test_apps_lists_only_consistent_entries(client):
    c, ver = client
    apps = c.get("/api/apps").json()
    assert [a["app"] for a in apps] == ["hs_advertiser"]
    versions = apps[0]["versions"]
    assert [v["version"] for v in versions] == [ver]   # v9.9.9 (mismatched header) skipped
    assert versions[0]["configurable"] is True
    assert versions[0]["size"] == IMAGE.stat().st_size


def test_app_files(client):
    c, ver = client
    r = c.get(f"/api/apps/hs_advertiser/{ver}/firmware.bin")
    assert r.status_code == 200 and r.content == IMAGE.read_bytes()
    assert "immutable" in r.headers["cache-control"]
    assert c.get(f"/api/apps/hs_advertiser/{ver}/methods.json").json()["methods_version"] == 1
    assert c.get(f"/api/apps/hs_advertiser/{ver}/default.config.json").json()["calls"]


@pytest.mark.parametrize("path", [
    "/api/apps/hs_advertiser/v9.9.9/firmware.bin",
    "/api/apps/hs_advertiser/{ver}/secret.txt",
    "/api/apps/hs_advertiser/{ver}/..%2F..%2F..%2Fsecret.txt",
    "/api/apps/..%2F/{ver}/firmware.bin",
    "/api/apps/nope/{ver}/firmware.bin",
])
def test_catalogue_rejects(client, path):
    c, ver = client
    assert c.get(path.format(ver=ver)).status_code == 404


def test_pages(client):
    c, _ = client
    for p in ("/", "/provision", "/sw.js", "/manifest.webmanifest", "/static/vendor/uPlot.iife.min.js"):
        assert c.get(p).status_code == 200, p


# ---------------- sync + fleet (needs Postgres) ----------------

needs_pg = pytest.mark.skipif(not PG, reason="TEST_PG_URL not set (use tests/run.sh)")


def config(ver, script=None, name="fast-blink"):
    return {"id": str(uuid.uuid4()), "app": "hs_advertiser", "version": ver, "name": name,
            "script": script or {"calls": [{"method": "config.set", "params": {"led": {"blink_hz": 4}}}]},
            "created_at": now(), "client": "pytest"}


def deployment(ver, device="58e6c513033c", ok=True, profile=None):
    return {"id": str(uuid.uuid4()), "device_id": device, "board_id": 1, "profile_id": profile,
            "profile_name": "p", "app": "hs_advertiser", "version": ver, "from_version": "v1.1.0",
            "flashed": True, "script": {"calls": []}, "results": [{"method": "config.set", "ok": ok}],
            "ok": ok, "error": None if ok else "boom", "started_at": now(), "finished_at": now(), "client": "pytest"}


@needs_pg
def test_sync_roundtrip_and_idempotency(client):
    c, ver = client
    start = c.get("/api/sync").json()["seq"]
    cfg = config(ver)
    prof = {"id": str(uuid.uuid4()), "name": "fast", "app": "hs_advertiser", "version": ver,
            "config_id": cfg["id"], "config_name": cfg["name"], "script": cfg["script"],
            "created_at": now(), "client": "pytest"}
    dep = deployment(ver, profile=prof["id"])
    body = {"configs": [cfg], "profiles": [prof], "deployments": [dep]}

    r = c.post("/api/sync", json=body).json()
    assert r["rejected"] == [] and r["accepted"]["configs"] == [cfg["id"]]
    again = c.post("/api/sync", json=body).json()  # offline outbox re-sent: no-op, no error
    assert again["rejected"] == []

    pulled = c.get(f"/api/sync?since={start}").json()
    assert pulled["seq"] > start
    assert [x["id"] for x in pulled["configs"]].count(cfg["id"]) == 1
    assert prof["id"] in [x["id"] for x in pulled["profiles"]]
    assert dep["id"] in [x["id"] for x in pulled["deployments"]]
    assert c.get(f"/api/sync?since={pulled['seq'] + 1000}").json()["configs"] == []


@needs_pg
def test_sync_rejects_invalid_configs(client):
    c, ver = client
    bad = config(ver, {"calls": [{"method": "config.set", "params": {"led": {"blink_hz": 99}}}]})
    per_device = config(ver, {"calls": [{"method": "board.set_id", "params": {"id": 2}}]})
    unknown_version = config("v0.0.1")
    r = c.post("/api/sync", json={"configs": [bad, per_device, unknown_version]}).json()
    assert r["accepted"]["configs"] == []
    errs = {x["id"]: x["errors"] for x in r["rejected"]}
    assert errs[bad["id"]] == ["call 1 (config.set): led.blink_hz: must be at most 10"]
    assert "per-device" in errs[per_device["id"]][0]
    assert errs[unknown_version["id"]] == ["unknown or non-configurable firmware version"]


@needs_pg
def test_fleet_latest_per_device(client):
    c, ver = client
    dev = "a1b2c3d4e5f6"
    first, second = deployment(ver, dev, ok=True), deployment(ver, dev, ok=False)
    c.post("/api/sync", json={"deployments": [first]})
    c.post("/api/sync", json={"deployments": [second]})
    row = next(r for r in c.get("/api/fleet").json() if r["device_id"] == dev)
    assert row["deployments"] == 2
    assert row["ok"] is False  # the latest (second) deployment wins


@needs_pg
def test_provisioning_role_cannot_update_or_delete():
    import psycopg
    with psycopg.connect(os.environ["PROVISIONING_DATABASE_URL"], autocommit=True) as conn:
        for sql in ("UPDATE provisioning.configs SET name = 'x'", "DELETE FROM provisioning.deployments",
                    "SELECT count(*) FROM readings"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(sql)
