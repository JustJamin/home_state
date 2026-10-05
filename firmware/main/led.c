/*
 * User LED: XIAO ESP32-C6 has one controllable LED on GPIO15, lit when the pin is LOW
 * (the red one is the hardware charge LED). The pattern belongs to the app
 * (app_led_cycle); device.identify overrides it with a fast blink for a few seconds.
 */
#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "app.h"
#include "hs.h"

#define LED_GPIO      GPIO_NUM_15
#define LED_ON        0
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
        /* copy, so a config.set mid-cycle can't tear the settings we're using */
        app_led_t led = settings_get()->led;
        app_led_cycle(&led, set);
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
