"""Shared test setup: environment before the app is imported, and ONE app lifespan
for the whole session (psycopg pools can't be reopened once closed)."""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
PG = os.environ.get("TEST_PG_URL")
os.environ.setdefault("DATABASE_URL", PG or "postgresql://unused")
if PG:
    os.environ.setdefault("PROVISIONING_DATABASE_URL", PG.replace("home_state:test@", "provisioning:test@"))
os.environ.setdefault("VAPID_PRIVATE_KEY", "test-private")
os.environ.setdefault("VAPID_PUBLIC_KEY", "test-public")


@pytest.fixture(scope="session")
def app_client():
    import app as appmod
    from fastapi.testclient import TestClient
    if PG:
        with TestClient(appmod.app) as c:  # runs the lifespan once: opens both pools
            yield c
    else:
        yield TestClient(appmod.app)
