/* hs_advertiser: the original app, kept as the bridge for boards on v1.3.0 and older.
 * Those boards only accept firmware whose project name is hs_advertiser; this build
 * has the family check, after which they can switch to any family app.
 * Settings (unchanged since v1.2.0): led {mode: off|blink|heartbeat, blink_hz}.
 * Uses the original NVS key ("settings"), so a board keeps its existing config. */
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "app.h"

typedef enum { LED_OFF = 0, LED_BLINK, LED_HEARTBEAT } mode_t_;
typedef struct {
    mode_t_ mode;
    float blink_hz;
} led_t;
_Static_assert(sizeof(led_t) <= APP_LED_MAX, "led settings too big");

static const char *const MODES[] = {"off", "blink", "heartbeat"};

const char *app_settings_key(void)
{
    return "settings";
}

void app_led_defaults(app_led_t *l)
{
    *(led_t *)l = (led_t){.mode = LED_BLINK, .blink_hz = 1.0f};
}

bool app_led_merge(const cJSON *obj, app_led_t *l, char *err, size_t err_len, char *field, size_t field_len)
{
    led_t *led = (led_t *)l;
    static const char *const KEYS[] = {"mode", "blink_hz", NULL};
    const char *bad;
    if (!app_only_keys(obj, KEYS, &bad)) {
        snprintf(field, field_len, "%s", bad);
        snprintf(err, err_len, "unknown setting");
        return false;
    }
    const cJSON *mode = cJSON_GetObjectItemCaseSensitive(obj, "mode");
    if (mode) {
        int m = -1;
        for (int i = 0; cJSON_IsString(mode) && i < 3; i++) {
            if (strcmp(mode->valuestring, MODES[i]) == 0) {
                m = i;
            }
        }
        if (m < 0) {
            snprintf(field, field_len, "mode");
            snprintf(err, err_len, "must be off, blink or heartbeat");
            return false;
        }
        led->mode = (mode_t_)m;
    }
    double d;
    bool present;
    if (!app_get_number(obj, "blink_hz", 0.1, 10, false, &d, &present, err, err_len)) {
        snprintf(field, field_len, "blink_hz");
        return false;
    }
    if (present) {
        led->blink_hz = (float)d;
    }
    return true;
}

cJSON *app_led_to_json(const app_led_t *l)
{
    const led_t *led = (const led_t *)l;
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "mode", MODES[led->mode]);
    cJSON_AddNumberToObject(o, "blink_hz", (double)((int)(led->blink_hz * 100 + 0.5f)) / 100);
    return o;
}

void app_led_cycle(const app_led_t *l, void (*set)(bool on))
{
    const led_t *led = (const led_t *)l;
    switch (led->mode) {
    case LED_OFF:
        set(false);
        vTaskDelay(pdMS_TO_TICKS(200));
        break;
    case LED_BLINK: {
        uint32_t half = (uint32_t)(500.0f / led->blink_hz);
        if (half < 20) {
            half = 20;
        }
        set(true);
        vTaskDelay(pdMS_TO_TICKS(half));
        set(false);
        vTaskDelay(pdMS_TO_TICKS(half));
        break;
    }
    case LED_HEARTBEAT: {
        uint32_t period = (uint32_t)(1000.0f / led->blink_hz);
        uint32_t rest = period > 400 ? period - 400 : 0;
        set(true);
        vTaskDelay(pdMS_TO_TICKS(80));
        set(false);
        vTaskDelay(pdMS_TO_TICKS(120));
        set(true);
        vTaskDelay(pdMS_TO_TICKS(80));
        set(false);
        vTaskDelay(pdMS_TO_TICKS(120 + rest));
        break;
    }
    }
}
