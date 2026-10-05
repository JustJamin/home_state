# BLE OTA protocol v1

How firmware gets onto a home_state node over Bluetooth LE. The node is in `firmware/main/ota.c`. There are two clients: `dashboards/fastapi-sse/static/ota.js` (the phone, via Web Bluetooth) and `tools/ota_client.py` (the bench, via bleak). All multi-byte values are little-endian.

> **No authentication.** Anyone in BLE range can flash any image whose project is `hs_advertiser`. This is an accepted risk for now. Rollback protects against images that crash or hang, not malicious ones.

## Discovery

- **Advert:** the node advertises every ~1 s with legacy advertising: flags, the name `hs-<board id>`, and manufacturer data 0xFFFF (payload v1, see the README). The payload is unchanged from v1.0.0.
- **Connectable:** the node is connectable (`ADV_IND`) while nobody is connected. While a client is connected, adverts continue as non-connectable (`ADV_NONCONN_IND`), so the scanner keeps receiving readings during an OTA.
- **Scan response:** the 128-bit service UUID. It's too big for the 31-byte advert.
- **One connection at a time.** The node disconnects a client after 60 s with no GATT activity.

## GATT service

Base UUID `2727b0xx-1ada-46ff-8cde-9e8f32a32c1a`:

| | UUID | Properties | Contents |
|---|---|---|---|
| Service | `2727b000-…` | | |
| INFO | `2727b001-…` | read | JSON (below) |
| CTRL | `2727b002-…` | write, notify | commands → node, replies ← node |
| DATA | `2727b003-…` | write without response, write | `[u32 offset][image bytes]` |

INFO:
```json
{"proto":1,"proj":"hs_advertiser","fw":"v1.1.0","idf":"v6.1","board":1,
 "part":"ota_0","state":"valid","rolled_back_from":null,"ota":"idle","mtu":517}
```
- `state`: `valid`, or `pending` (a new image that hasn't confirmed itself yet).
- `rolled_back_from`: the version of the last image that failed and was rolled back, or `null`.
- `ota`: `idle`, `receiving` or `received`.
- `mtu`: the negotiated ATT MTU of the current connection.

## Commands (client → CTRL, write with response)

| Byte | Command | Payload | Node does |
|---|---|---|---|
| `01` | BEGIN | `u32 size, u8[32] sha256` | erase-as-you-go OTA into the other slot (`OTA_WITH_SEQUENTIAL_WRITES`), start hashing |
| `05` | SYNC | | reply with how many bytes it has accepted |
| `02` | END | | check received == size and sha256, then `esp_ota_end()` (validates the image) |
| `03` | APPLY | | set the boot partition, reply, reboot after 300 ms |
| `04` | ABORT | | drop the transfer (disconnecting does the same) |

## Replies (node → CTRL, notify): `[u8 type][u8 status][payload]`

| Type | Reply | Payload |
|---|---|---|
| `81` | BEGIN_RSP | `u16 chunk` (bytes of image per DATA write), `u16 window` (suggested burst) |
| `85` | SYNC_RSP | `u32 received` |
| `82` / `83` / `84` | END / APPLY / ABORT | |
| `91` | NAK (unsolicited; the transfer was aborted) | `u32 offset` |

Status codes:

| Code | Name |
|---|---|
| 0 | OK |
| 1 | BAD_STATE |
| 2 | TOO_BIG |
| 3 | FLASH |
| 4 | BAD_OFFSET |
| 5 | HASH |
| 6 | IMAGE_INVALID |
| 7 | WRONG_PROJECT (checked from the app description in the first 112 bytes) |
| 8 | BAD_CMD |

## Transfer

1. Subscribe to CTRL notifications. Read INFO.
2. **BEGIN.** Wait for BEGIN_RSP; it gives `chunk` (= min(MTU−3, 512) − 4, so a write is never more than 512 bytes, Web Bluetooth's limit) and `window` (16).
3. Repeat until done:
   - Send up to `window` DATA writes of `[offset][chunk bytes]`, **awaiting each one** (Chrome rejects overlapping GATT operations).
   - Send **SYNC** and set `offset = received` from SYNC_RSP.
   - The node ignores any write whose offset isn't exactly what it expects. A lost write is therefore just resent after the next SYNC, and the client never acts on a stale reply.
4. **END**, then **APPLY**. The node reboots into the new slot.
5. Reconnect and read INFO: `fw` should be the new version and `state` should be `valid`.

Fallback: if writes without response keep failing, write DATA *with* response instead. It's slower, and the protocol is otherwise unchanged. `ota.js` switches automatically after 3 consecutive failed bursts.

## Rollback

- The bootloader is built with `BOOTLOADER_APP_ROLLBACK_ENABLE`. A freshly applied image boots as `pending`.
- It marks itself `valid` after the BLE host syncs and the first 5 s advert refresh succeeds.
- If it panics before then, or the task watchdog fires, the bootloader goes back to the previous slot.
- If it is still pending after **60 s**, it rolls itself back and reboots.
- After a rollback, INFO's `rolled_back_from` names the failed version.

The test builds `HS_TEST_NEVER_VALID` and `HS_TEST_PANIC_ON_BOOT` (menuconfig → home_state advertiser) exercise both paths.

## Measured (2026-10-05, 645 KB image, MTU 517, chunk 508)

| Client | Mode | Time | Rate |
|---|---|---|---|
| bleak on lenovo's AR3012 (BT 4.0) | without response | 39–46 s | 14–16 KB/s |
| bleak on lenovo's AR3012 (BT 4.0) | with response | 67 s | 9.5 KB/s |
| Chrome on the phone | | *(see v1.1.0 tag)* | |

The AR3012 sometimes resets under sustained traffic, which drops the link mid-transfer. The node aborts cleanly. This is tracked in the sysadmin TODO.
