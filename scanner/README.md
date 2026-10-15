# scanner

Listens for home_state boards via BlueZ (D-Bus, using `bleak`), decodes the v1 payload and prints one JSON line per new reading. Repeat adverts with the same counter are dropped.

```sh
cd scanner
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scanner.py           # Ctrl-C to stop
.venv/bin/python -m unittest          # decoder tests
```

Needs the host's `bluetoothd` and a user in the `bluetooth` group. No root is needed.

Note: BlueZ gives manufacturer data as `{company_id: bytes}` with the company ID already stripped, so the offsets in `payload.py` are 2 less than in the README table.

## Stalls and self-heal

If no BLE advert from **any** device arrives for `STALL_SECONDS` (120), the scanner assumes the adapter has gone deaf. It then:
1. writes a heartbeat with zero adverts, which the health checks show as a failing Bluetooth adapter;
2. power-cycles the adapter over D-Bus (`adapter.py`), the same as `bluetoothctl power off` then `power on`. BlueZ's D-Bus policy lets any user do this, so it works as `nobody`;
3. exits, so Kubernetes restarts it with a fresh scan.

The power-cycle is there because on 2026-10-15 the AR3012 came back from a USB suspend powered but deaf, and only a power-cycle fixed it. `RESET_ADAPTER=0` turns it off; `BLE_ADAPTER` (default `hci0`) picks the adapter.

