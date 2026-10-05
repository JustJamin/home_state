#!/usr/bin/env python3
"""Build each node app's JSON-RPC files from the shared methods and its own LED block.

    firmware/config/common.json + firmware/apps/<app>/app.json
        -> firmware/apps/<app>/methods.json   (param schemas: what configs are validated against)
        -> firmware/apps/<app>/default.json   (the app's default config script)

    python3 tools/app_config.py           # write all apps
    python3 tools/app_config.py --check   # fail if any written file is out of date (tests/CI)
"""
import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "firmware"


def build(app: str) -> tuple[dict, dict]:
    common = json.loads((ROOT / "config/common.json").read_text())
    spec = json.loads((ROOT / "apps" / app / "app.json").read_text())
    methods = {"app": app, "methods_version": common["methods_version"],
               "description": f"{app}: {spec['description']}", "rf_stacks": common["rf_stacks"],
               "methods": copy.deepcopy(common["methods"])}
    methods["methods"]["config.set"]["params"]["properties"]["led"] = spec["led"]
    d = spec["default"]
    default = {"app": app, "name": "default", "description": d["description"],
               "calls": [{"method": "config.set", "params": {
                   "update_interval_ms": 5000, "adv_interval_ms": 1000, "led": d["led"]}}]}
    return methods, default


def apps() -> list[str]:
    return sorted(p.parent.name for p in (ROOT / "apps").glob("*/app.json"))


def main() -> int:
    check = "--check" in sys.argv
    stale = []
    for app in apps():
        for name, data in zip(("methods.json", "default.json"), build(app)):
            path = ROOT / "apps" / app / name
            text = json.dumps(data, indent=2) + "\n"
            if check:
                if not path.exists() or path.read_text() != text:
                    stale.append(str(path))
            else:
                path.write_text(text)
    if stale:
        print("out of date (run tools/app_config.py):\n  " + "\n  ".join(stale))
        return 1
    print(("up to date: " if check else "wrote: ") + ", ".join(apps()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
