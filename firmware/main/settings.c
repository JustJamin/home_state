/*
 * Node settings: what config.set can change. The intervals are common to every app;
 * the "led" block belongs to the app (app.h). Stored as JSON in NVS under the app's
 * own key (app_settings_key()), so switching a board between apps never mixes their
 * settings, and switching back restores the old ones. Missing keys take defaults.
 * Keep the ranges here in step with firmware/config/common.json and apps/<app>/app.json.
 */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"

#include "app.h"
#include "hs.h"

static const char *TAG = "settings";

static hs_settings_t s_settings;

static void defaults(hs_settings_t *s)
{
    s->update_interval_ms = 5000;
    s->adv_interval_ms = 1000;
    app_led_defaults(&s->led);
}

const hs_settings_t *settings_get(void)
{
    return &s_settings;
}

cJSON *settings_to_json(void)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "update_interval_ms", s_settings.update_interval_ms);
    cJSON_AddNumberToObject(root, "adv_interval_ms", s_settings.adv_interval_ms);
    cJSON_AddItemToObject(root, "led", app_led_to_json(&s_settings.led));
    return root;
}

/* ---- helpers shared with the apps ---- */

bool app_only_keys(const cJSON *obj, const char *const *allowed, const char **bad)
{
    const cJSON *item;
    cJSON_ArrayForEach(item, obj) {
        bool ok = false;
        for (const char *const *k = allowed; *k; k++) {
            ok |= strcmp(item->string, *k) == 0;
        }
        if (!ok) {
            *bad = item->string;
            return false;
        }
    }
    return true;
}

bool app_get_number(const cJSON *obj, const char *key, double lo, double hi, bool integer,
                    double *out, bool *present, char *err, size_t err_len)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    *present = v != NULL;
    if (!v) {
        return true;
    }
    if (!cJSON_IsNumber(v) || (integer && v->valuedouble != floor(v->valuedouble))) {
        snprintf(err, err_len, integer ? "must be an integer" : "must be a number");
        return false;
    }
    if (v->valuedouble < lo || v->valuedouble > hi) {
        snprintf(err, err_len, "must be between %g and %g", lo, hi);
        return false;
    }
    *out = v->valuedouble;
    return true;
}

bool app_get_bool(const cJSON *obj, const char *key, bool *out, bool *present, char *err, size_t err_len)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    *present = v != NULL;
    if (!v) {
        return true;
    }
    if (!cJSON_IsBool(v)) {
        snprintf(err, err_len, "must be true or false");
        return false;
    }
    *out = cJSON_IsTrue(v);
    return true;
}

/* ---- merge / persist ---- */

static bool fail(char *err, size_t err_len, char *field, size_t field_len, const char *f, const char *msg)
{
    snprintf(field, field_len, "%s", f);
    snprintf(err, err_len, "%s", msg);
    return false;
}

/* err already holds the message (from a helper): just name the field */
static bool fail_field(char *field, size_t field_len, const char *f)
{
    snprintf(field, field_len, "%s", f);
    return false;
}

/* Validate `partial` into `out` (starting from `base`). No side effects. */
static bool merge(const hs_settings_t *base, const cJSON *partial, hs_settings_t *out,
                  char *err, size_t err_len, char *field, size_t field_len)
{
    *out = *base;
    if (!cJSON_IsObject(partial)) {
        return fail(err, err_len, field, field_len, "", "params must be an object");
    }
    static const char *const KEYS[] = {"update_interval_ms", "adv_interval_ms", "led", NULL};
    const char *bad;
    if (!app_only_keys(partial, KEYS, &bad)) {
        return fail(err, err_len, field, field_len, bad, "unknown setting");
    }
    double d;
    bool present;
    if (!app_get_number(partial, "update_interval_ms", 1000, 600000, true, &d, &present, err, err_len)) {
        return fail_field(field, field_len, "update_interval_ms");
    }
    if (present) {
        out->update_interval_ms = (uint32_t)d;
    }
    if (!app_get_number(partial, "adv_interval_ms", 100, 10240, true, &d, &present, err, err_len)) {
        return fail_field(field, field_len, "adv_interval_ms");
    }
    if (present) {
        out->adv_interval_ms = (uint16_t)d;
    }
    const cJSON *led = cJSON_GetObjectItemCaseSensitive(partial, "led");
    if (led) {
        if (!cJSON_IsObject(led)) {
            return fail(err, err_len, field, field_len, "led", "must be an object");
        }
        char f[40];
        if (!app_led_merge(led, &out->led, err, err_len, f, sizeof(f))) {
            char path[48];
            snprintf(path, sizeof(path), "led.%s", f);
            return fail_field(field, field_len, path);
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
        if (nvs_set_str(h, app_settings_key(), s) != ESP_OK || nvs_commit(h) != ESP_OK) {
            ESP_LOGE(TAG, "failed to persist settings");
        }
        nvs_close(h);
    }
    cJSON_free(s);
    cJSON_Delete(j);
}

void settings_load(void)
{
    defaults(&s_settings);
    nvs_handle_t h;
    size_t len = 0;
    if (nvs_open("hs", NVS_READONLY, &h) != ESP_OK) {
        return;
    }
    const char *key = app_settings_key();
    if (nvs_get_str(h, key, NULL, &len) == ESP_OK && len > 0 && len < 1024) {
        char buf[1024];
        nvs_get_str(h, key, buf, &len);
        cJSON *j = cJSON_Parse(buf);
        char err[64], field[48];
        hs_settings_t base, loaded;
        defaults(&base);
        if (j && merge(&base, j, &loaded, err, sizeof(err), field, sizeof(field))) {
            s_settings = loaded;
            ESP_LOGI(TAG, "loaded (%s): %s", key, buf);
        } else {
            ESP_LOGW(TAG, "stored settings invalid (%s %s); using defaults", field, j ? err : "parse error");
        }
        cJSON_Delete(j);
    } else {
        ESP_LOGI(TAG, "no stored settings for this app (%s): defaults", key);
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
    defaults(&s_settings);
    save();
    hs_settings_changed();
}
