#pragma once
/*
 * A node app (main/apps/<app>.c, chosen at build time: -DHS_APP=<app>) owns the
 * "led" block of the settings: its defaults, validation, JSON and blink pattern.
 * Everything else (BLE, OTA, JSON-RPC, intervals, board ID) is shared. Each app's
 * JSON-RPC schema is firmware/apps/<app>/app.json; keep the two in step.
 */
#include <stdbool.h>
#include <stddef.h>

#include "cJSON.h"

#define APP_LED_MAX 32

/* Opaque storage for the app's LED settings (each app casts it to its own struct). */
typedef struct {
    _Alignas(8) unsigned char b[APP_LED_MAX];
} app_led_t;

void app_led_defaults(app_led_t *led);

/* Validate a partial "led" object and merge it into *led (which holds the current
 * values). On error fill err and field (relative, e.g. "blink_hz") and return false;
 * *led is then unspecified, so callers merge into a copy. */
bool app_led_merge(const cJSON *obj, app_led_t *led, char *err, size_t err_len, char *field, size_t field_len);

cJSON *app_led_to_json(const app_led_t *led);

/* Run one cycle of the pattern (blocks for the cycle's length). set(true) lights the LED. */
void app_led_cycle(const app_led_t *led, void (*set)(bool on));

/* NVS key the app keeps its settings under, so apps never read each other's. */
const char *app_settings_key(void);

/* ---- helpers for apps (settings.c) ---- */

/* Read an optional number in [lo, hi] from obj[key]. Returns false (and fills err)
 * if present but invalid; *present says whether it was there. */
bool app_get_number(const cJSON *obj, const char *key, double lo, double hi, bool integer,
                    double *out, bool *present, char *err, size_t err_len);
bool app_get_bool(const cJSON *obj, const char *key, bool *out, bool *present, char *err, size_t err_len);
/* Fail if obj has a key not in the NULL-terminated list; *bad gets the key. */
bool app_only_keys(const cJSON *obj, const char *const *allowed, const char **bad);
