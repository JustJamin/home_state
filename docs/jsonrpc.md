# Node JSON-RPC (hs_advertiser, methods v1)

From firmware v1.2.0, every node answers **JSON-RPC 2.0** over two transports:

| Transport | Framing | Client |
|---|---|---|
| **USB serial** (USB-Serial-JTAG, `/dev/ttyACM0`) | one request per line (`\n`), one response per line | `tools/rpc_client.py --serial /dev/ttyACM0 …` |
| **BLE**, characteristic `2727b004-1ada-46ff-8cde-9e8f32a32c1a` (write + notify, in the OTA service) | `[u8 flags][bytes]`: `0x02` START, `0x01` FINAL, single packet = `0x03`; up to 4 KB per message | provisioning page (`static/rpc.js`), `tools/rpc_client.py --ble hs-01 …` |

- **USB serial and the log:** the USB port also carries the log. Clients must skip any line that isn't a JSON object containing `"jsonrpc"`.
- **USB serial and resets:** don't touch DTR/RTS when opening the port. Setting them (even to False) passes through DTR=0/RTS=1, which resets the chip.
- **BLE:** subscribe to notifications before writing. Requests are written with response. A notification fragment holds at most MTU−4 bytes of JSON.

No authentication, the same as OTA (accepted risk).

## Methods

The param schemas are machine-readable in [`firmware/config/methods.json`](../firmware/config/methods.json), published with each release. The provisioning page validates config scripts against them.

| Method | Params | Result |
|---|---|---|
| `rpc.discover` | – | `{methods_version, methods: [...]}` |
| `device.info` | – | `{device_id, ble_address, app, version, idf, chip, chip_rev, board_id, methods_version, partition, state, rolled_back_from}` (`ble_address` from v1.3.0) |
| `device.status` | – | `{uptime_s, free_heap, min_free_heap, reset_reason, temp_c, counter, ble_connected}` |
| `config.get` | – | current settings (below) |
| `config.set` | partial settings | `{config, reboot_required}` (all v1 settings apply live) |
| `config.reset` | – | settings after reset to defaults |
| `board.set_id` | `{id: 0–255}` | `{board_id}`. **Per-device**: not allowed in shared configs |
| `device.identify` | `{seconds?: 1–300}` (default 10) | `{seconds}`. Fast LED blink |
| `device.reboot` | – | `{rebooting: true}`; reboots 300 ms later |
| `ota.status` | – | `{transfer, received, size, next_partition, partition, state, rolled_back_from}` |
| `readings.read` | `{boot_id?, after_uptime_s?, limit?: 1–50}` | `{boot_id, same_boot, now_uptime_s, board_id, buffered, more, readings: [{c, u, t}]}`: the last hour of readings for the phone gateway, oldest first, paged. A `boot_id` from an earlier boot is ignored and you get everything from the oldest. Not allowed in configs (v1.3.1+) |

From v1.3.1 `device.info` also reports `family: "home_state-node"`. Any family app can be flashed over any other.

`ble_address` is the address the node advertises from, which is what the scanner records (`readings.address`). On the ESP32-C6 it is the factory MAC + 2, e.g. `58:E6:C5:13:03:3E`.

`device_id` is the chip's factory MAC from eFuse (e.g. `58e6c513033c`). It is permanent and matches the USB serial number. It's what the fleet record keys on. `board_id` is the short ID in adverts and readings (`hs-01`), stored in NVS and changed only with `board.set_id`.

## Settings

The intervals are common to every app. The `led` block **is the app's own** (`firmware/apps/<app>/app.json`; see `firmware/README.md`). Below is the original `hs_advertiser` set.

### hs_advertiser

```json
{"update_interval_ms": 5000, "adv_interval_ms": 1000, "led": {"mode": "blink", "blink_hz": 1}}
```

| Key | Range | Effect |
|---|---|---|
| `update_interval_ms` | 1000–600000 | payload (counter, temperature) refresh |
| `adv_interval_ms` | 100–10240 | BLE advertising interval |
| `led.mode` | `off` \| `blink` \| `heartbeat` | user LED (XIAO ESP32-C6: GPIO15, active-low) |
| `led.blink_hz` | 0.1–10 | blink rate (heartbeat: cycles per second) |

Settings are stored as JSON in NVS (`hs/settings`). Unknown stored keys are ignored, and missing ones take defaults.

## Errors

Errors are standard JSON-RPC: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` bad params, `-32603` internal. Param errors name the offending field:

```json
{"jsonrpc":"2.0","error":{"code":-32602,"message":"must be between 0.1 and 10","data":{"field":"led.blink_hz"}},"id":1}
```

## Config scripts

A **config** is a script of JSON-RPC calls, run in order:

```json
{"calls": [{"method": "config.set", "params": {"led": {"mode": "blink", "blink_hz": 4}}}]}
```

- **Radio stack:** `methods.json` may declare `rf_stacks` (`{versions, default}`). A profile records one of them; nothing is sent to the node yet.
- **Defaults:** each firmware version ships one as `default.config.json` ([`firmware/config/default.json`](../firmware/config/default.json)).
- **Validation:** `static/schema.js` (phone) and `scripts.py` (server) validate scripts identically against `methods.json`. They share test vectors (`dashboards/fastapi-sse/tests/script_vectors.json`). Methods marked `script: false` (read-only) or `per_device: true` (`board.set_id`) are refused in shared configs.
- **Reboots:** a call to a method marked `reboots: true` makes the deploy runner reconnect before the next call.
- **On the bench:** `tools/rpc_client.py --serial /dev/ttyACM0 --script my-config.json`.
