/* single-blink: one flash per cycle. Settings: led {enabled, blink_hz, on_ms}. */
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "app.h"

typedef struct {
    bool enabled;
    float blink_hz; /* cycles per second */
    uint16_t on_ms; /* how long each flash lasts */
} led_t;
_Static_assert(sizeof(led_t) <= APP_LED_MAX, "led settings too big");

const char *app_settings_key(void)
{
    return "s:single-blink";
}

void app_led_defaults(app_led_t *l)
{
    *(led_t *)l = (led_t){.enabled = true, .blink_hz = 1.0f, .on_ms = 100};
}

bool app_led_merge(const cJSON *obj, app_led_t *l, char *err, size_t err_len, char *field, size_t field_len)
{
    led_t *led = (led_t *)l;
    static const char *const KEYS[] = {"enabled", "blink_hz", "on_ms", NULL};
    const char *bad;
    if (!app_only_keys(obj, KEYS, &bad)) {
        snprintf(field, field_len, "%s", bad);
        snprintf(err, err_len, "unknown setting");
        return false;
    }
    double d;
    bool b, present;
    if (!app_get_bool(obj, "enabled", &b, &present, err, err_len)) {
        snprintf(field, field_len, "enabled");
        return false;
    }
    if (present) {
        led->enabled = b;
    }
    if (!app_get_number(obj, "blink_hz", 0.1, 10, false, &d, &present, err, err_len)) {
        snprintf(field, field_len, "blink_hz");
        return false;
    }
    if (present) {
        led->blink_hz = (float)d;
    }
    if (!app_get_number(obj, "on_ms", 10, 1000, true, &d, &present, err, err_len)) {
        snprintf(field, field_len, "on_ms");
        return false;
    }
    if (present) {
        led->on_ms = (uint16_t)d;
    }
    return true;
}

cJSON *app_led_to_json(const app_led_t *l)
{
    const led_t *led = (const led_t *)l;
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "enabled", led->enabled);
    cJSON_AddNumberToObject(o, "blink_hz", (double)((int)(led->blink_hz * 100 + 0.5f)) / 100);
    cJSON_AddNumberToObject(o, "on_ms", led->on_ms);
    return o;
}

void app_led_cycle(const app_led_t *l, void (*set)(bool on))
{
    const led_t *led = (const led_t *)l;
    uint32_t period = (uint32_t)(1000.0f / led->blink_hz);
    if (!led->enabled) {
        set(false);
        vTaskDelay(pdMS_TO_TICKS(200));
        return;
    }
    /* on_ms longer than the period would never switch off: keep at least 20 ms dark */
    uint32_t on = led->on_ms < period - 20 ? led->on_ms : (period > 40 ? period - 20 : period / 2);
    set(true);
    vTaskDelay(pdMS_TO_TICKS(on));
    set(false);
    vTaskDelay(pdMS_TO_TICKS(period - on));
}
