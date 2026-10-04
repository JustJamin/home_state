# home_state

Collect readings from Seeed XIAO ESP32-C6 boards over BLE and store them in a database.
Everything runs on `lenovo` (Debian 13): first in Docker, then in a single-node k3s cluster.

Started: 2026-10-04

---

## Architecture

```
XIAO ESP32-C6 boards ──BLE advertising──▶ lenovo (hci0) ──▶ scanner container ──▶ Postgres container
   (transmitters)        (broadcast only)    bluetoothd        (Python + bleak)        (readings table)
```

- **Transmitters:** each XIAO ESP32-C6 broadcasts its readings inside BLE advertising packets. Nothing connects to the boards; they only broadcast.
- **Receiver:** `lenovo` has a Qualcomm AR3012 adapter (Bluetooth 4.0, `hci0`) and runs the host's `bluetoothd` (BlueZ 5.82).
  - The scanner talks to BlueZ over D-Bus using `bleak`, so its container only needs the host's `/run/dbus/system_bus_socket` mounted. No `--privileged` or raw HCI access is needed.
- **Storage:** Postgres. Each advert received becomes one row, holding the board ID, RSSI, a timestamp and the decoded payload.

### Constraints
- **The receiver only supports Bluetooth 4.0.** The C6 supports BLE 5, but the boards must use **legacy advertising** (31-byte adverts, 1M PHY). Extended or Coded-PHY adverts won't be seen.
- **Docker-published ports bypass ufw on lenovo.** Never publish Postgres to the network; bind it to `127.0.0.1` if the host needs access.
- **lenovo is only reachable over Tailscale.** Host setup (Docker and k3s installs, firewall rules) lives in the `sysadmin` repo, not here.

### Host dependencies (sysadmin repo)
This project is blocked on these host items. They're tracked under `## home_state dependencies` in `~/repo/sysadmin/TODO.md`, so track them there, not here:
- `jamin` in the `dialout` group, so the board on `/dev/ttyACM0` can be flashed (step 1)
- apt build dependencies for ESP-IDF (step 1)
- ESP-IDF toolchain, target esp32c6, in `~/esp/esp-idf` (step 1)
- Docker + Compose (step 4)
- k3s single-node (step 5)

---

## Advertising payload (draft v1)

The payload goes in **manufacturer-specific data** (AD type `0xFF`). Multi-byte values are little-endian.

| Offset | Size | Field        | Notes                                          |
|-------:|-----:|--------------|------------------------------------------------|
| 0      | 2    | company ID   | `0xFFFF` (reserved for testing / internal use) |
| 2      | 1    | version      | payload format version, starts at `1`          |
| 3      | 1    | board ID     | unique per board                               |
| 4      | 2    | counter      | increments each update; used to drop duplicate adverts |
| 6      | 2    | temp_c_x100  | v1 dummy: int16, °C × 100 (triangle wave 20.00–23.00) |
| 8      | 2    | uptime_s     | v1 dummy: uint16, seconds since boot (wraps)   |

Device name: `hs-<board id>` (e.g. `hs-01`). Keep the whole advert ≤ 31 bytes.
Once the format settles, move this table into `docs/payload.md` and keep it as the source of truth.

---

## Plan

1. **Firmware:** make a XIAO ESP32-C6 advertise dummy data in the format above, then roll it out to all boards.
2. **Host check:** confirm lenovo can hear the boards with `bluetoothctl` (`scan le`) or `sudo btmon`. No installs needed.
3. **Scanner on the host:** a Python script using `bleak` that filters on company ID `0xFFFF`, decodes the payload and prints it.
4. **Docker + Compose:** run the scanner and Postgres containers together and write readings to Postgres.
5. **k3s:** a single-node cluster on lenovo. Put Postgres in a StatefulSet with a `local-path` PVC. Run the scanner as a Deployment pinned to lenovo that mounts the D-Bus socket via `hostPath`.
6. **Later:** real sensors, Grafana dashboards, backups of the database.

## Planned layout

```
home_state/
  README.md
  firmware/     <- XIAO ESP32-C6 transmitter code
  scanner/      <- Python BLE scanner + Dockerfile
  deploy/       <- compose.yaml, k8s/ manifests
  docs/         <- payload format, notes
```

## Status

- [x] Repo created
- [x] Firmware: dummy-data advertiser on one board
- [x] lenovo sees the adverts (bluetoothctl / btmon)
- [ ] Scanner script on the host
- [ ] Docker Compose: scanner + Postgres
- [ ] k3s deployment
