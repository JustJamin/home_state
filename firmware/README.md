# firmware

ESP-IDF + NimBLE transmitter for the XIAO ESP32-C6. It broadcasts the v1 payload (see the top-level README) in non-connectable legacy adverts, about once a second, and refreshes the payload every 5 s.

Needs ESP-IDF in `~/esp/esp-idf` (tracked in `~/repo/sysadmin/TODO.md`).

```sh
. ~/esp/esp-idf/export.sh
cd firmware
idf.py build
idf.py -p /dev/ttyACM0 flash monitor     # Ctrl-] to exit monitor
```

## Board IDs

`HS_BOARD_ID` (default 1) and `HS_UPDATE_INTERVAL_MS` are set under `idf.py menuconfig` → "home_state advertiser". To build for another board without touching the default config, use a separate build dir and sdkconfig:

```sh
echo 'CONFIG_HS_BOARD_ID=2' > /tmp/board02.defaults
idf.py -B build-02 -DSDKCONFIG=build-02/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;/tmp/board02.defaults" build flash
```
