/*
 * home_state transmitter: broadcasts readings in BLE legacy advertising packets,
 * and accepts firmware updates over BLE (ota.c).
 * Payload format (manufacturer-specific data) is documented in the repo README.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "driver/temperature_sensor.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "services/gap/ble_svc_gap.h"

#include "ota.h"

#define HS_COMPANY_ID      0xFFFF
#define HS_PAYLOAD_VERSION 1
#define HS_MFG_LEN         10
/* temp_c_x100 value meaning "no reading" */
#define HS_TEMP_NONE       INT16_MIN
/* 1600 * 0.625 ms = 1 s */
#define HS_ADV_ITVL        1600

static const char *TAG = "hs";

static char s_name[8];
static uint8_t s_board_id;
static uint8_t s_own_addr_type;
static uint8_t s_mfg[HS_MFG_LEN];
static uint16_t s_counter;
static temperature_sensor_handle_t s_tsens;
static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static SemaphoreHandle_t s_adv_lock;

static void put_u16_le(uint8_t *p, uint16_t v)
{
    p[0] = v & 0xFF;
    p[1] = v >> 8;
}

/* Chip die temperature: reads several degrees above ambient (self-heating). */
static int16_t read_temp_c_x100(void)
{
    float temp_c;
    esp_err_t err = temperature_sensor_get_celsius(s_tsens, &temp_c);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "temperature read failed: %s", esp_err_to_name(err));
        return HS_TEMP_NONE;
    }
    return (int16_t)lroundf(temp_c * 100);
}

static void build_payload(void)
{
    int16_t temp_c_x100 = read_temp_c_x100();
    uint16_t uptime_s = (uint16_t)(xTaskGetTickCount() / configTICK_RATE_HZ);

    put_u16_le(&s_mfg[0], HS_COMPANY_ID);
    s_mfg[2] = HS_PAYLOAD_VERSION;
    s_mfg[3] = s_board_id;
    put_u16_le(&s_mfg[4], s_counter);
    put_u16_le(&s_mfg[6], (uint16_t)temp_c_x100);
    put_u16_le(&s_mfg[8], uptime_s);
}

/* Board ID lives in NVS so one firmware image fits every board. It's seeded
 * from CONFIG_HS_BOARD_ID the first time a board boots with an empty NVS. */
static uint8_t load_board_id(void)
{
    nvs_handle_t h;
    uint8_t id = CONFIG_HS_BOARD_ID;
    ESP_ERROR_CHECK(nvs_open("hs", NVS_READWRITE, &h));
    esp_err_t err = nvs_get_u8(h, "board_id", &id);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        id = CONFIG_HS_BOARD_ID;
        ESP_ERROR_CHECK(nvs_set_u8(h, "board_id", id));
        ESP_ERROR_CHECK(nvs_commit(h));
        ESP_LOGI(TAG, "board ID %u stored in NVS", id);
    } else {
        ESP_ERROR_CHECK(err);
    }
    nvs_close(h);
    return id;
}

static int gap_event(struct ble_gap_event *event, void *arg);

/* Restart advertising with the current payload. Connectable while nobody is
 * connected; non-connectable while connected (we allow one connection, and
 * readings must keep flowing during an OTA). Called from the update task and
 * the GAP event handler, hence the lock. */
static int adv_restart(void)
{
    xSemaphoreTake(s_adv_lock, portMAX_DELAY);
    bool connected = s_conn != BLE_HS_CONN_HANDLE_NONE;

    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (uint8_t *)s_name;
    fields.name_len = strlen(s_name);
    fields.name_is_complete = 1;
    fields.mfg_data = s_mfg;
    fields.mfg_data_len = sizeof(s_mfg);

    struct ble_gap_adv_params params = {
        .conn_mode = connected ? BLE_GAP_CONN_MODE_NON : BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
        .itvl_min = HS_ADV_ITVL,
        .itvl_max = HS_ADV_ITVL,
    };

    ble_gap_adv_stop();
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc == 0) {
        rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
    }
    xSemaphoreGive(s_adv_lock);
    return rc;
}

static void log_payload(void)
{
    char hex[HS_MFG_LEN * 2 + 1];

    for (int i = 0; i < HS_MFG_LEN; i++) {
        sprintf(&hex[i * 2], "%02x", s_mfg[i]);
    }
    ESP_LOGI(TAG, "%s counter=%u mfr=%s%s", s_name, s_counter, hex,
             s_conn != BLE_HS_CONN_HANDLE_NONE ? " (connected)" : "");
}

static void update_task(void *arg)
{
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(CONFIG_HS_UPDATE_INTERVAL_MS));

        s_counter++;
        build_payload();

        int rc = adv_restart();
        if (rc != 0) {
            ESP_LOGE(TAG, "advert update failed: rc=%d", rc);
            continue;
        }
        log_payload();
        /* sync + GATT + adverts all work: this image is good */
        ota_mark_valid();
    }
}

static int gap_event(struct ble_gap_event *event, void *arg)
{
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_conn = event->connect.conn_handle;
            ota_on_connect(s_conn);
        } else {
            ESP_LOGW(TAG, "connect failed: status=%d", event->connect.status);
        }
        adv_restart();  /* connectable adverts stop on connect; keep broadcasting, non-connectable */
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnected: reason=0x%x", event->disconnect.reason);
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        ota_on_disconnect();
        adv_restart();  /* connectable again */
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        ota_on_subscribe(event->subscribe.attr_handle, event->subscribe.cur_notify);
        break;
    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "mtu %u", event->mtu.value);
        break;
    default:
        break;
    }
    return 0;
}

static void on_sync(void)
{
    int rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_hs_id_infer_auto failed: rc=%d", rc);
        return;
    }

    uint8_t addr[6];
    ble_hs_id_copy_addr(s_own_addr_type, addr, NULL);
    ESP_LOGI(TAG, "address %02x:%02x:%02x:%02x:%02x:%02x",
             addr[5], addr[4], addr[3], addr[2], addr[1], addr[0]);

    /* scan response: the OTA service UUID (no room for it in the 31-byte advert) */
    struct ble_hs_adv_fields rsp = {0};
    rsp.uuids128 = (ble_uuid128_t *)ota_service_uuid();
    rsp.num_uuids128 = 1;
    rsp.uuids128_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGE(TAG, "scan response failed: rc=%d", rc);
    }

    build_payload();
    rc = adv_restart();
    if (rc != 0) {
        ESP_LOGE(TAG, "advertising start failed: rc=%d", rc);
        return;
    }
    log_payload();

    xTaskCreate(update_task, "hs_update", 3072, NULL, 5, NULL);
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "host reset: reason=%d", reason);
}

static void host_task(void *param)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ota_boot_check();
#if CONFIG_HS_TEST_PANIC_ON_BOOT
    ESP_LOGE(TAG, "HS_TEST_PANIC_ON_BOOT: crashing on purpose (rollback test)");
    abort();
#endif

    s_board_id = load_board_id();
    snprintf(s_name, sizeof(s_name), "hs-%02u", s_board_id);
    s_adv_lock = xSemaphoreCreateMutex();

    /* -10..80 C is the range with the best accuracy on the C6 */
    temperature_sensor_config_t tsens_cfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    ESP_ERROR_CHECK(temperature_sensor_install(&tsens_cfg, &s_tsens));
    ESP_ERROR_CHECK(temperature_sensor_enable(s_tsens));

    ESP_ERROR_CHECK(nimble_port_init());
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;

    ESP_ERROR_CHECK(ota_gatt_init(s_board_id) == 0 ? ESP_OK : ESP_FAIL);
    ESP_ERROR_CHECK(ble_svc_gap_device_name_set(s_name) == 0 ? ESP_OK : ESP_FAIL);

    nimble_port_freertos_init(host_task);
}
