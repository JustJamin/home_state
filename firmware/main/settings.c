/*
 * Node settings: the things config.set can change. Stored as a JSON string in
 * NVS (namespace "hs", key "settings"), so new keys can be added without a
 * migration; unknown keys in NVS are ignored, missing ones take defaults.
 * Keep the ranges here in step with firmware/config/methods.json.
 */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"

#include "hs.h"

static const char *TAG = "settings";

static const hs_settings_t DEFAULTS = {
    .update_interval_ms = 5000,
    .adv_interval_ms = 1000,
    .led_mode = LED_BLINK,
    .led_blink_hz = 1.0f,
};

static hs_settings_t s_settings;

static const char *const LED_MODES[] = {"off", "blink", "heartbeat"};

const hs_settings_t *settings_get(void)
{
    return &s_settings;
}

cJSON *settings_to_json(void)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "update_interval_ms", s_settings.update_interval_ms);
    cJSON_AddNumberToObject(root, "adv_interval_ms", s_settings.adv_interval_ms);
    cJSON *led = cJSON_AddObjectToObject(root, "led");
    cJSON_AddStringToObject(led, "mode", LED_MODES[s_settings.led_mode]);
    /* round to 2 dp so 0.1 doesn't come back as 0.10000000149 */
    cJSON_AddNumberToObject(led, "blink_hz", roundf(s_settings.led_blink_hz * 100) / 100);
    return root;
}

static bool fail(char *err, size_t err_len, char *field, size_t field_len, const char *f, const char *msg)
{
    snprintf(field, field_len, "%s", f);
    snprintf(err, err_len, "%s", msg);
    return false;
}

static bool get_number(const cJSON *obj, const char *key, double lo, double hi, double *out, bool *present,
                       char *err, size_t err_len, char *field, size_t field_len, const char *path)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    *present = v != NULL;
    if (!v) {
        return true;
    }
    if (!cJSON_IsNumber(v)) {
        return fail(err, err_len, field, field_len, path, "must be a number");
    }
    if (v->valuedouble < lo || v->valuedouble > hi) {
        char msg[64];
        snprintf(msg, sizeof(msg), "must be between %g and %g", lo, hi);
        return fail(err, err_len, field, field_len, path, msg);
    }
    *out = v->valuedouble;
    return true;
}

/* Validate `partial` into `out` (starting from `base`). No side effects. */
static bool merge(const hs_settings_t *base, const cJSON *partial, hs_settings_t *out,
                  char *err, size_t err_len, char *field, size_t field_len)
{
    *out = *base;
    if (!cJSON_IsObject(partial)) {
        return fail(err, err_len, field, field_len, "", "params must be an object");
    }
    const cJSON *item;
    cJSON_ArrayForEach(item, partial) {
        if (strcmp(item->string, "update_interval_ms") && strcmp(item->string, "adv_interval_ms") &&
            strcmp(item->string, "led")) {
            return fail(err, err_len, field, field_len, item->string, "unknown setting");
        }
    }
    double d;
    bool present;
    if (!get_number(partial, "update_interval_ms", 1000, 600000, &d, &present, err, err_len, field, field_len,
                    "update_interval_ms")) {
        return false;
    }
    if (present) {
        out->update_interval_ms = (uint32_t)d;
    }
    if (!get_number(partial, "adv_interval_ms", 100, 10240, &d, &present, err, err_len, field, field_len,
                    "adv_interval_ms")) {
        return false;
    }
    if (present) {
        out->adv_interval_ms = (uint16_t)d;
    }

    const cJSON *led = cJSON_GetObjectItemCaseSensitive(partial, "led");
    if (led) {
        if (!cJSON_IsObject(led)) {
            return fail(err, err_len, field, field_len, "led", "must be an object");
        }
        cJSON_ArrayForEach(item, led) {
            if (strcmp(item->string, "mode") && strcmp(item->string, "blink_hz")) {
                char f[40];
                snprintf(f, sizeof(f), "led.%s", item->string);
                return fail(err, err_len, field, field_len, f, "unknown setting");
            }
        }
        const cJSON *mode = cJSON_GetObjectItemCaseSensitive(led, "mode");
        if (mode) {
            int m = -1;
            for (int i = 0; cJSON_IsString(mode) && i < 3; i++) {
                if (strcmp(mode->valuestring, LED_MODES[i]) == 0) {
                    m = i;
                }
            }
            if (m < 0) {
                return fail(err, err_len, field, field_len, "led.mode", "must be off, blink or heartbeat");
            }
            out->led_mode = (led_mode_t)m;
        }
        if (!get_number(led, "blink_hz", 0.1, 10, &d, &present, err, err_len, field, field_len, "led.blink_hz")) {
            return false;
        }
        if (present) {
            out->led_blink_hz = (float)d;
        }
    }
    return true;
}

static void save(void)
{
    cJSON *j = settings_to_json();
    char *s = cJSON_PrintUnformatted(j);
    nvs_handle_t h;
    if (nvs_open("hs", NVS_READWRITE, &h) == ESP_OK) {
        if (nvs_set_str(h, "settings", s) != ESP_OK || nvs_commit(h) != ESP_OK) {
            ESP_LOGE(TAG, "failed to persist settings");
        }
        nvs_close(h);
    }
    cJSON_free(s);
    cJSON_Delete(j);
}

void settings_load(void)
{
    s_settings = DEFAULTS;
    nvs_handle_t h;
    size_t len = 0;
    if (nvs_open("hs", NVS_READONLY, &h) != ESP_OK) {
        return;
    }
    if (nvs_get_str(h, "settings", NULL, &len) == ESP_OK && len > 0 && len < 1024) {
        char buf[1024];
        nvs_get_str(h, "settings", buf, &len);
        cJSON *j = cJSON_Parse(buf);
        char err[64], field[40];
        hs_settings_t loaded;
        if (j && merge(&DEFAULTS, j, &loaded, err, sizeof(err), field, sizeof(field))) {
            s_settings = loaded;
            ESP_LOGI(TAG, "loaded: %s", buf);
        } else {
            ESP_LOGW(TAG, "stored settings invalid (%s %s); using defaults", field, j ? err : "parse error");
        }
        cJSON_Delete(j);
    }
    nvs_close(h);
}

bool settings_apply(const cJSON *partial, char *err, size_t err_len, char *field, size_t field_len)
{
    hs_settings_t next;
    if (!merge(&s_settings, partial, &next, err, err_len, field, field_len)) {
        return false;
    }
    s_settings = next;
    save();
    hs_settings_changed();
    return true;
}

void settings_reset(void)
{
    s_settings = DEFAULTS;
    save();
    hs_settings_changed();
}
