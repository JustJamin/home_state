/*
 * User LED: XIAO ESP32-C6 has a yellow LED on GPIO15, lit when the pin is LOW.
 * Modes come from settings (led.mode, led.blink_hz); device.identify overrides
 * them with a fast blink for a few seconds.
 */
#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "hs.h"

#define LED_GPIO GPIO_NUM_15
#define LED_ON   0
#define LED_OFF_LEVEL 1

static volatile int64_t s_identify_until_us;

void led_identify(uint32_t seconds)
{
    s_identify_until_us = esp_timer_get_time() + (int64_t)seconds * 1000000;
}

static void set(bool on)
{
    gpio_set_level(LED_GPIO, on ? LED_ON : LED_OFF_LEVEL);
}

static void led_task(void *arg)
{
    for (;;) {
        if (esp_timer_get_time() < s_identify_until_us) {
            set(true);
            vTaskDelay(pdMS_TO_TICKS(60));
            set(false);
            vTaskDelay(pdMS_TO_TICKS(60));
            continue;
        }
        const hs_settings_t *s = settings_get();
        switch (s->led_mode) {
        case LED_OFF:
            set(false);
            vTaskDelay(pdMS_TO_TICKS(200));
            break;
        case LED_BLINK: {
            /* 50% duty cycle at blink_hz; re-read settings every half period */
            uint32_t half_ms = (uint32_t)(500.0f / s->led_blink_hz);
            if (half_ms < 20) {
                half_ms = 20;
            }
            set(true);
            vTaskDelay(pdMS_TO_TICKS(half_ms));
            set(false);
            vTaskDelay(pdMS_TO_TICKS(half_ms));
            break;
        }
        case LED_HEARTBEAT: {
            /* two short pulses, then rest; one cycle per 1/blink_hz seconds */
            uint32_t period_ms = (uint32_t)(1000.0f / s->led_blink_hz);
            uint32_t rest = period_ms > 400 ? period_ms - 400 : 0;
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
}

void led_init(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << LED_GPIO,
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&io);
    set(false);
    xTaskCreate(led_task, "hs_led", 2048, NULL, 3, NULL);
}
