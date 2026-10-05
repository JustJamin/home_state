#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "host/ble_uuid.h"

/* home_state BLE OTA service (proto v1). Spec: docs/ota-protocol.md */

/* 128-bit service UUID, for the scan response */
const ble_uuid128_t *ota_service_uuid(void);

/* Register the GATT service. Call before the host syncs. */
int ota_gatt_init(uint8_t board_id);

/* GAP connection lifecycle, called from main's GAP event handler. */
void ota_on_connect(uint16_t conn_handle);
void ota_on_disconnect(void);
void ota_on_subscribe(uint16_t attr_handle, bool notify);

/* Rollback bookkeeping: call once at boot, and mark valid once the app has proven itself. */
void ota_boot_check(void);
void ota_mark_valid(void);
