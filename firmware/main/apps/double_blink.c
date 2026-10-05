/* double-blink: flash, gap, flash, then a longer pause.
 * Settings: led {enabled, flash_ms, gap_ms, pause_ms}. */
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "app.h"

typedef struct {
    bool enabled;
    uint16_t flash_ms; /* each of the two flashes */
    uint16_t gap_ms;   /* dark time between them */
    uint16_t pause_ms; /* dark time after the pair */
} led_t;
_Static_assert(sizeof(led_t) <= APP_LED_MAX, "led settings too big");

const char *app_settings_key(void)
{
    return "s:double-blink";
}

void app_led_defaults(app_led_t *l)
{
    *(led_t *)l = (led_t){.enabled = true, .flash_ms = 80, .gap_ms = 120, .pause_ms = 1000};
}

bool app_led_merge(const cJSON *obj, app_led_t *l, char *err, size_t err_len, char *field, size_t field_len)
{
    led_t *led = (led_t *)l;
    static const char *const KEYS[] = {"enabled", "flash_ms", "gap_ms", "pause_ms", NULL};
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
    static const struct { const char *key; double lo, hi; size_t off; } NUMS[] = {
        {"flash_ms", 20, 500, offsetof(led_t, flash_ms)},
        {"gap_ms", 20, 1000, offsetof(led_t, gap_ms)},
        {"pause_ms", 200, 10000, offsetof(led_t, pause_ms)},
    };
    for (size_t i = 0; i < sizeof(NUMS) / sizeof(NUMS[0]); i++) {
        if (!app_get_number(obj, NUMS[i].key, NUMS[i].lo, NUMS[i].hi, true, &d, &present, err, err_len)) {
            snprintf(field, field_len, "%s", NUMS[i].key);
            return false;
        }
        if (present) {
            *(uint16_t *)((char *)led + NUMS[i].off) = (uint16_t)d;
        }
    }
    return true;
}

cJSON *app_led_to_json(const app_led_t *l)
{
    const led_t *led = (const led_t *)l;
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "enabled", led->enabled);
    cJSON_AddNumberToObject(o, "flash_ms", led->flash_ms);
    cJSON_AddNumberToObject(o, "gap_ms", led->gap_ms);
    cJSON_AddNumberToObject(o, "pause_ms", led->pause_ms);
    return o;
}

void app_led_cycle(const app_led_t *l, void (*set)(bool on))
{
    const led_t *led = (const led_t *)l;
    if (!led->enabled) {
        set(false);
        vTaskDelay(pdMS_TO_TICKS(200));
        return;
    }
    set(true);
    vTaskDelay(pdMS_TO_TICKS(led->flash_ms));
    set(false);
    vTaskDelay(pdMS_TO_TICKS(led->gap_ms));
    set(true);
    vTaskDelay(pdMS_TO_TICKS(led->flash_ms));
    set(false);
    vTaskDelay(pdMS_TO_TICKS(led->pause_ms));
}
