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
