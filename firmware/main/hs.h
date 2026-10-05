#pragma once
/* Shared interface between the hs_advertiser modules. */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "app.h"
#include "cJSON.h"

/* ---- settings (settings.c): persisted in NVS, changed via config.set ---- */

typedef struct {
    uint32_t update_interval_ms; /* payload refresh */
    uint16_t adv_interval_ms;    /* advertising interval */
    app_led_t led;               /* the app's own LED settings (app.h) */
} hs_settings_t;

void settings_load(void);
const hs_settings_t *settings_get(void);
cJSON *settings_to_json(void);
/* Validate and merge a partial settings object; persist and apply on success.
 * On failure returns false and fills err/field (nothing is changed). */
bool settings_apply(const cJSON *partial, char *err, size_t err_len, char *field, size_t field_len);
void settings_reset(void);

/* ---- app (main.c) ---- */

uint8_t hs_board_id(void);
bool hs_set_board_id(uint8_t id);
uint16_t hs_counter(void);
float hs_temp_c(void);          /* NAN if the sensor read fails */
bool hs_connected(void);
void hs_settings_changed(void); /* re-apply advert interval etc. */
void hs_restart_after(uint32_t ms);

/* Readings kept for the phone gateway (main.c) */
typedef struct {
    uint16_t counter;
    uint32_t uptime_s;
    int16_t temp_c_x100; /* INT16_MIN = no reading */
} hs_reading_t;
uint32_t hs_boot_id(void);
/* Copy up to max buffered readings with uptime_s > after_uptime_s (-1 = all), oldest first.
 * *more: there are more after these; *buffered: how many the node holds in total. */
size_t hs_readings_after(int64_t after_uptime_s, hs_reading_t *out, size_t max, bool *more, size_t *buffered);

/* ---- LED (led.c) ---- */

void led_init(void);
void led_identify(uint32_t seconds);

/* ---- JSON-RPC (rpc.c) ---- */

/* Handle one JSON-RPC 2.0 request. Returns a malloc'd response string,
 * or NULL for a notification (no id). Caller frees. */
char *rpc_handle(const char *request, size_t len);

void rpc_usb_start(void);
