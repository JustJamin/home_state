# firmware

ESP-IDF v6.1 + NimBLE firmware for the XIAO ESP32-C6 (ESP32-C6FH4, 4 MB flash).
- **Readings:** it reads the chip's internal temperature sensor and broadcasts the v1 payload (see the top-level README) in legacy adverts about once a second, refreshing the payload every 5 s.
- **Updates over the air:** it accepts firmware over BLE ([docs/ota-protocol.md](../docs/ota-protocol.md)) from the dashboard's provisioning page or `tools/ota_client.py`.
- **JSON-RPC** over USB serial and BLE ([docs/jsonrpc.md](../docs/jsonrpc.md)): device info, settings (`config.set`, persisted in NVS), LED, board ID, reboot. Try `tools/.venv/bin/python tools/rpc_client.py --serial /dev/ttyACM0 device.info`.

Needs ESP-IDF in `~/esp/esp-idf` (tracked in `~/repo/sysadmin/TODO.md`).

## Flash layout and the one-time USB migration

`partitions.csv` has two app slots (`ota_0` and `ota_1`, 1.9 MB each), plus `otadata`, NVS and coredump. There's no factory app. Boards on v1.0.0 firmware used a single-app layout. Moving a board to this layout needs **one USB flash that erases everything**:

```sh
. ~/esp/esp-idf/export.sh
cd firmware
rm -f sdkconfig && idf.py fullclean       # sdkconfig.defaults only applies to a fresh sdkconfig
idf.py -p /dev/ttyACM0 erase-flash flash monitor     # Ctrl-] to exit monitor
```

After that, update boards over Bluetooth. A plain `idf.py flash` over USB still works too. It writes `ota_0` and resets `otadata` to boot from it.

## Board IDs

The board ID is stored in NVS (`hs/board_id`), so **one image works for every board**. A board with an empty NVS stores `CONFIG_HS_BOARD_ID` (default 1) the first time it boots. So for a new board, set `HS_BOARD_ID` for its USB migration flash:

```sh
echo 'CONFIG_HS_BOARD_ID=2' > /tmp/board02.defaults
idf.py -B build-02 -DSDKCONFIG=build-02/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;/tmp/board02.defaults" build erase-flash flash
```

## Releases

The firmware version comes from `git describe`, so tagged releases report `vX.Y.Z`.

```sh
git tag -a v1.2.3 -m "..."          # with hardware notes; see the existing tags
firmware/release.sh                 # refuses a dirty or untagged tree; --dev for test builds
deploy/push-dashboards.sh fastapi-sse
```

`release.sh` publishes `<app>/<version>/{firmware.bin, default.config.json, methods.json}` to `dashboards/fastapi-sse/firmware/` (gitignored, baked into the dashboard image) and to `~/home_state-firmware/` on lenovo (the durable copy). Update `config/default.json` and `config/methods.json` with the firmware: `methods.json` must match `main/rpc.c` and `main/settings.c`.

## Testing OTA from lenovo

```sh
scanner/.venv/bin/python tools/ota_client.py info
scanner/.venv/bin/python tools/ota_client.py flash firmware/build/hs_advertiser.bin
# fault injection: --bad-hash, --truncate N, --drop-chunk N, --disconnect-at BYTES, --with-response, --no-apply
```

**Rollback test builds:** enable `HS_TEST_NEVER_VALID` or `HS_TEST_PANIC_ON_BOOT` in menuconfig ("home_state advertiser"), give the build its own version with `CONFIG_APP_PROJECT_VER_FROM_CONFIG`, then flash it **over OTA only**. The node must come back on the previous image, with `rolled_back_from` set. Never USB-flash `HS_TEST_PANIC_ON_BOOT`: with no previous image it boot-loops.

lenovo's AR3012 adapter sometimes resets under sustained OTA traffic (see the sysadmin TODO). If a bench transfer drops, just rerun it.
