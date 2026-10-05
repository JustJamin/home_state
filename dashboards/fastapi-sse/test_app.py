"""Firmware endpoint tests (no database needed: TestClient without lifespan).

    FW_IMAGE=path/to/hs_advertiser.bin python -m pytest test_app.py
"""

import hashlib
import os
import shutil
from pathlib import Path

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://unused")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    image = Path(os.environ.get("FW_IMAGE", Path(__file__).parents[2] / "firmware/build/hs_advertiser.bin"))
    if not image.exists():
        pytest.skip(f"no firmware image at {image}")
    shutil.copy(image, tmp_path / "hs_advertiser-v9.9.9.bin")
    (tmp_path / "hs_advertiser-broken.bin").write_bytes(b"not an image" * 100)
    (tmp_path / "secret.txt").write_text("nope")

    import app as appmod
    from fastapi.testclient import TestClient
    monkeypatch.setattr(appmod, "FIRMWARE_DIR", tmp_path)
    return TestClient(appmod.app), image.read_bytes()


def test_list_reads_metadata_from_image(client):
    c, img = client
    fw = c.get("/api/firmware").json()
    assert [f["file"] for f in fw] == ["hs_advertiser-v9.9.9.bin"]  # broken image and other files skipped
    f = fw[0]
    assert f["project"] == "hs_advertiser"
    assert f["size"] == len(img)
    assert f["sha256"] == hashlib.sha256(img).hexdigest()
    assert f["idf"].startswith("v")


def test_download(client):
    c, img = client
    r = c.get("/api/firmware/hs_advertiser-v9.9.9.bin")
    assert r.status_code == 200
    assert r.content == img
    assert "immutable" in r.headers["cache-control"]


@pytest.mark.parametrize("name", [
    "secret.txt",
    "hs_advertiser-broken.bin",       # matches the pattern but isn't a valid image
    "..%2Fapp.py",
    "hs_advertiser-..%2F..%2Fapp.py.bin",
    "hs_advertiser-nope.bin",
])
def test_rejects_anything_not_in_catalogue(client, name):
    c, _ = client
    assert c.get(f"/api/firmware/{name}").status_code == 404


def test_pages_and_vendored_assets(client):
    c, _ = client
    assert c.get("/").status_code == 200
    assert c.get("/provision").status_code == 200
    assert c.get("/static/vendor/uPlot.iife.min.js").status_code == 200
