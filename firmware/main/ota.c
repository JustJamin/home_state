/*
 * home_state BLE OTA service, protocol v1 (spec: docs/ota-protocol.md).
 *
 * INFO (read)            JSON: firmware version, board, partition, rollback state
 * CTRL (write + notify)  BEGIN / SYNC / END / APPLY / ABORT; replies (and fatal NAKs) as notifications
 * DATA (write [no rsp])  [u32 offset LE][image bytes]
 *
 * No authentication: any client in range can flash a valid hs_advertiser
 * image (accepted risk for now). Rollback protects against images that
 * crash or never mark themselves valid, not against malicious ones.
 */
#include "ota.h"

#include <stdio.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "host/ble_hs.h"
#include "psa/crypto.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

static const char *TAG = "ota";

#define PROTO_VERSION     1
#define WINDOW_CHUNKS     16           /* suggested burst between SYNCs */
#define MAX_CHUNK_DATA    508          /* Web Bluetooth caps a write at 512 bytes, minus the 4-byte offset */
#define IDLE_TIMEOUT_US   (60LL * 1000 * 1000)
#define VERIFY_TIMEOUT_US (60LL * 1000 * 1000)
#define APP_DESC_OFFSET   32           /* image header (24) + first segment header (8) */
#define HEADER_PEEK       (APP_DESC_OFFSET + 80)  /* enough to cover esp_app_desc_t.project_name */

enum { CMD_BEGIN = 0x01, CMD_END = 0x02, CMD_APPLY = 0x03, CMD_ABORT = 0x04, CMD_SYNC = 0x05 };
enum { RSP_BEGIN = 0x81, RSP_END = 0x82, RSP_APPLY = 0x83, RSP_ABORT = 0x84, RSP_SYNC = 0x85, RSP_NAK = 0x91 };
enum {
    ST_OK = 0, ST_BAD_STATE = 1, ST_TOO_BIG = 2, ST_FLASH = 3, ST_BAD_OFFSET = 4,
    ST_HASH = 5, ST_IMAGE_INVALID = 6, ST_WRONG_PROJECT = 7, ST_BAD_CMD = 8,
};

/* 2727b0xx-1ada-46ff-8cde-9e8f32a32c1a, little-endian for NimBLE */
#define HS_UUID(x) BLE_UUID128_INIT(0x1a, 0x2c, 0xa3, 0x32, 0x8f, 0x9e, 0xde, 0x8c, \
                                    0xff, 0x46, 0xda, 0x1a, (x), 0xb0, 0x27, 0x27)
static const ble_uuid128_t SVC_UUID = HS_UUID(0x00);
static const ble_uuid128_t INFO_UUID = HS_UUID(0x01);
static const ble_uuid128_t CTRL_UUID = HS_UUID(0x02);
static const ble_uuid128_t DATA_UUID = HS_UUID(0x03);

static enum { XFER_IDLE, XFER_RECEIVING, XFER_RECEIVED } s_xfer;
static const char *const XFER_NAMES[] = {"idle", "receiving", "received"};

static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_info_handle, s_ctrl_handle, s_data_handle;
static bool s_ctrl_subscribed;
static uint8_t s_board_id;

static const esp_partition_t *s_target;
static esp_ota_handle_t s_ota;
static bool s_ota_open;
static psa_hash_operation_t s_hash;
static bool s_hash_open;
static uint8_t s_expected_sha[32];
static uint32_t s_size, s_received;
static bool s_gap_logged;
static uint8_t s_peek[HEADER_PEEK];

static esp_timer_handle_t s_idle_timer, s_verify_timer, s_restart_timer;
static bool s_pending_verify;
static char s_rolled_back_from[32];

const ble_uuid128_t *ota_service_uuid(void)
{
    return &SVC_UUID;
}

/* ---- helpers ---- */

static void reply(uint8_t type, uint8_t status, const void *payload, size_t len)
{
    if (s_conn == BLE_HS_CONN_HANDLE_NONE || !s_ctrl_subscribed) {
        ESP_LOGW(TAG, "reply 0x%02x/%u dropped: client not subscribed to CTRL", type, status);
        return;
    }
    uint8_t buf[2 + 4];
    buf[0] = type;
    buf[1] = status;
    memcpy(&buf[2], payload, len);
    struct os_mbuf *om = ble_hs_mbuf_from_flat(buf, 2 + len);
    int rc = ble_gatts_notify_custom(s_conn, s_ctrl_handle, om);
    if (rc != 0) {
        ESP_LOGW(TAG, "notify failed: rc=%d", rc);
    }
}

static void reply_offset(uint8_t type, uint8_t status, uint32_t offset)
{
    uint8_t p[4] = {offset & 0xff, (offset >> 8) & 0xff, (offset >> 16) & 0xff, offset >> 24};
    reply(type, status, p, sizeof(p));
}

static uint32_t get_u32_le(const uint8_t *p)
{
    return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void reset_transfer(const char *why)
{
    if (s_xfer != XFER_IDLE) {
        ESP_LOGW(TAG, "transfer reset (%s) at %lu/%lu bytes", why,
                 (unsigned long)s_received, (unsigned long)s_size);
    }
    if (s_ota_open) {
        esp_ota_abort(s_ota);
        s_ota_open = false;
    }
    if (s_hash_open) {
        psa_hash_abort(&s_hash);
        s_hash_open = false;
    }
    s_xfer = XFER_IDLE;
    s_received = s_size = 0;
    s_gap_logged = false;
}

static void touch_idle_timer(void)
{
    if (s_conn != BLE_HS_CONN_HANDLE_NONE) {
        esp_timer_restart(s_idle_timer, IDLE_TIMEOUT_US);
    }
}

/* ---- commands ---- */

static void cmd_begin(const uint8_t *p, uint16_t len)
{
    if (len != 1 + 4 + 32) {
        reply(RSP_BEGIN, ST_BAD_CMD, NULL, 0);
        return;
    }
    reset_transfer("new BEGIN");

    uint32_t size = get_u32_le(&p[1]);
    s_target = esp_ota_get_next_update_partition(NULL);
    if (s_target == NULL || size == 0 || size > s_target->size) {
        ESP_LOGW(TAG, "BEGIN rejected: size %lu, slot %lu", (unsigned long)size,
                 (unsigned long)(s_target ? s_target->size : 0));
        reply(RSP_BEGIN, ST_TOO_BIG, NULL, 0);
        return;
    }
    esp_err_t err = esp_ota_begin(s_target, OTA_WITH_SEQUENTIAL_WRITES, &s_ota);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin: %s", esp_err_to_name(err));
        reply(RSP_BEGIN, ST_FLASH, NULL, 0);
        return;
    }
    s_ota_open = true;
    s_hash = psa_hash_operation_init();
    if (psa_hash_setup(&s_hash, PSA_ALG_SHA_256) != PSA_SUCCESS) {
        reset_transfer("hash setup failed");
        reply(RSP_BEGIN, ST_FLASH, NULL, 0);
        return;
    }
    s_hash_open = true;
    memcpy(s_expected_sha, &p[5], 32);
    s_size = size;
    s_xfer = XFER_RECEIVING;

    int chunk = ble_att_mtu(s_conn) - 3 - 4;
    if (chunk > MAX_CHUNK_DATA) {
        chunk = MAX_CHUNK_DATA;
    }
    if (chunk < 16) {
        chunk = 16;
    }
    ESP_LOGI(TAG, "BEGIN %lu bytes -> %s (mtu %u, chunk %d, window %d)", (unsigned long)size,
             s_target->label, ble_att_mtu(s_conn), chunk, WINDOW_CHUNKS);
    uint8_t rsp[4] = {chunk & 0xff, chunk >> 8, WINDOW_CHUNKS & 0xff, WINDOW_CHUNKS >> 8};
    reply(RSP_BEGIN, ST_OK, rsp, sizeof(rsp));
}

static void cmd_end(void)
{
    if (s_xfer != XFER_RECEIVING || s_received != s_size) {
        reply(RSP_END, ST_BAD_STATE, NULL, 0);
        return;
    }
    uint8_t sha[32];
    size_t sha_len = 0;
    psa_status_t ps = psa_hash_finish(&s_hash, sha, sizeof(sha), &sha_len);
    s_hash_open = false;
    if (ps != PSA_SUCCESS || sha_len != 32 || memcmp(sha, s_expected_sha, 32) != 0) {
        reset_transfer("sha256 mismatch");
        reply(RSP_END, ST_HASH, NULL, 0);
        return;
    }
    esp_err_t err = esp_ota_end(s_ota); /* also validates the image */
    s_ota_open = false;
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_end: %s", esp_err_to_name(err));
        reset_transfer("image invalid");
        reply(RSP_END, err == ESP_ERR_OTA_VALIDATE_FAILED ? ST_IMAGE_INVALID : ST_FLASH, NULL, 0);
        return;
    }
    s_xfer = XFER_RECEIVED;
    ESP_LOGI(TAG, "END ok: image verified in %s", s_target->label);
    reply(RSP_END, ST_OK, NULL, 0);
}

static void restart_cb(void *arg)
{
    esp_restart();
}

static void cmd_apply(void)
{
    if (s_xfer != XFER_RECEIVED) {
        reply(RSP_APPLY, ST_BAD_STATE, NULL, 0);
        return;
    }
    esp_err_t err = esp_ota_set_boot_partition(s_target);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_set_boot_partition: %s", esp_err_to_name(err));
        reply(RSP_APPLY, ST_FLASH, NULL, 0);
        return;
    }
    ESP_LOGI(TAG, "APPLY: booting %s in 300 ms", s_target->label);
    reply(RSP_APPLY, ST_OK, NULL, 0);
    esp_timer_start_once(s_restart_timer, 300 * 1000);  /* let the notification go out first */
}

static void on_ctrl_write(const uint8_t *p, uint16_t len)
{
    if (len < 1) {
        return;
    }
    switch (p[0]) {
    case CMD_BEGIN:
        cmd_begin(p, len);
        break;
    case CMD_END:
        cmd_end();
        break;
    case CMD_APPLY:
        cmd_apply();
        break;
    case CMD_SYNC:
        /* the client asks where we are after each burst; it resumes from here */
        s_gap_logged = false;
        reply_offset(RSP_SYNC, s_xfer == XFER_IDLE ? ST_BAD_STATE : ST_OK, s_received);
        break;
    case CMD_ABORT:
        reset_transfer("ABORT");
        reply(RSP_ABORT, ST_OK, NULL, 0);
        break;
    default:
        reply(p[0] | 0x80, ST_BAD_CMD, NULL, 0);
    }
}

static void on_data_write(const uint8_t *p, uint16_t len)
{
    if (s_xfer != XFER_RECEIVING || len < 5) {
        return;
    }
    uint32_t offset = get_u32_le(p);
    const uint8_t *data = p + 4;
    uint16_t n = len - 4;

    if (offset != s_received) {
        /* gap or duplicate: ignore; the client's next SYNC tells it where to resume */
        if (!s_gap_logged) {
            ESP_LOGW(TAG, "chunk at %lu, expected %lu: ignoring until SYNC", (unsigned long)offset,
                     (unsigned long)s_received);
            s_gap_logged = true;
        }
        return;
    }
    if (s_received + n > s_size) {
        reset_transfer("data past declared size");
        reply_offset(RSP_NAK, ST_TOO_BIG, 0);
        return;
    }

    /* check the app description before going far: refuse images for another project */
    if (s_received < HEADER_PEEK) {
        uint32_t take = HEADER_PEEK - s_received < n ? HEADER_PEEK - s_received : n;
        memcpy(&s_peek[s_received], data, take);
        if (s_received + take == HEADER_PEEK) {
            const esp_app_desc_t *d = (const esp_app_desc_t *)&s_peek[APP_DESC_OFFSET];
            if (d->magic_word != ESP_APP_DESC_MAGIC_WORD ||
                strncmp(d->project_name, esp_app_get_description()->project_name, sizeof(d->project_name)) != 0) {
                ESP_LOGW(TAG, "image is not %s (got '%.32s')", esp_app_get_description()->project_name,
                         d->magic_word == ESP_APP_DESC_MAGIC_WORD ? d->project_name : "?");
                reset_transfer("wrong project");
                reply_offset(RSP_NAK, ST_WRONG_PROJECT, 0);
                return;
            }
            ESP_LOGI(TAG, "incoming image: %.32s %.32s", d->project_name, d->version);
        }
    }

    esp_err_t err = esp_ota_write(s_ota, data, n);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_write at %lu: %s", (unsigned long)offset, esp_err_to_name(err));
        reset_transfer("flash write failed");
        reply_offset(RSP_NAK, err == ESP_ERR_OTA_VALIDATE_FAILED ? ST_IMAGE_INVALID : ST_FLASH, 0);
        return;
    }
    psa_hash_update(&s_hash, data, n);
    s_received += n;
}

static int info_json(char *buf, size_t size)
{
    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *run = esp_ota_get_running_partition();
    char rolled[48] = "null";
    if (s_rolled_back_from[0]) {
        snprintf(rolled, sizeof(rolled), "\"%s\"", s_rolled_back_from);
    }
    return snprintf(buf, size,
                    "{\"proto\":%d,\"proj\":\"%s\",\"fw\":\"%s\",\"idf\":\"%s\",\"board\":%u,"
                    "\"part\":\"%s\",\"state\":\"%s\",\"rolled_back_from\":%s,\"ota\":\"%s\",\"mtu\":%u}",
                    PROTO_VERSION, app->project_name, app->version, app->idf_ver, s_board_id,
                    run ? run->label : "?", s_pending_verify ? "pending" : "valid", rolled,
                    XFER_NAMES[s_xfer], s_conn == BLE_HS_CONN_HANDLE_NONE ? 0 : ble_att_mtu(s_conn));
}

static int access_cb(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    touch_idle_timer();

    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR && attr_handle == s_info_handle) {
        char json[256];
        int n = info_json(json, sizeof(json));
        return os_mbuf_append(ctxt->om, json, n) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        static uint8_t buf[4 + 512];
        uint16_t len = 0;
        if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &len) != 0) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        if (attr_handle == s_ctrl_handle) {
            on_ctrl_write(buf, len);
        } else if (attr_handle == s_data_handle) {
            on_data_write(buf, len);
        }
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static const struct ble_gatt_svc_def s_services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &SVC_UUID.u,
        .characteristics = (struct ble_gatt_chr_def[]){
            {.uuid = &INFO_UUID.u, .access_cb = access_cb, .flags = BLE_GATT_CHR_F_READ,
             .val_handle = &s_info_handle},
            {.uuid = &CTRL_UUID.u, .access_cb = access_cb,
             .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_NOTIFY, .val_handle = &s_ctrl_handle},
            {.uuid = &DATA_UUID.u, .access_cb = access_cb,
             .flags = BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_WRITE, .val_handle = &s_data_handle},
            {0},
        },
    },
    {0},
};

/* ---- lifecycle ---- */

static void idle_cb(void *arg)
{
    if (s_conn != BLE_HS_CONN_HANDLE_NONE) {
        ESP_LOGW(TAG, "connection idle for 60 s: disconnecting");
        ble_gap_terminate(s_conn, BLE_ERR_REM_USER_CONN_TERM);
    }
}

static void verify_timeout_cb(void *arg)
{
    ESP_LOGE(TAG, "new firmware never marked itself valid: rolling back");
    esp_ota_mark_app_invalid_rollback_and_reboot();
}

static void timers_init(void)
{
    if (s_idle_timer) {
        return;
    }
    const esp_timer_create_args_t idle = {.callback = idle_cb, .name = "ota_idle"};
    const esp_timer_create_args_t verify = {.callback = verify_timeout_cb, .name = "ota_verify"};
    const esp_timer_create_args_t restart = {.callback = restart_cb, .name = "ota_restart"};
    ESP_ERROR_CHECK(esp_timer_create(&idle, &s_idle_timer));
    ESP_ERROR_CHECK(esp_timer_create(&verify, &s_verify_timer));
    ESP_ERROR_CHECK(esp_timer_create(&restart, &s_restart_timer));
}

void ota_boot_check(void)
{
    timers_init();
    const esp_partition_t *run = esp_ota_get_running_partition();
    ESP_LOGI(TAG, "running %s @0x%lx, firmware %s", run->label, (unsigned long)run->address,
             esp_app_get_description()->version);

    const esp_partition_t *bad = esp_ota_get_last_invalid_partition();
    esp_app_desc_t desc;
    if (bad && esp_ota_get_partition_description(bad, &desc) == ESP_OK) {
        strlcpy(s_rolled_back_from, desc.version, sizeof(s_rolled_back_from));
        ESP_LOGW(TAG, "last invalid image: %s in %s (rolled back)", desc.version, bad->label);
    }

    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(run, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
        s_pending_verify = true;
        ESP_LOGW(TAG, "image pending verification: must mark itself valid within 60 s");
        esp_timer_start_once(s_verify_timer, VERIFY_TIMEOUT_US);
    }
}

void ota_mark_valid(void)
{
    if (!s_pending_verify) {
        return;
    }
#if CONFIG_HS_TEST_NEVER_VALID
    ESP_LOGW(TAG, "HS_TEST_NEVER_VALID: not marking valid (rollback test)");
    return;
#endif
    esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    if (err == ESP_OK) {
        s_pending_verify = false;
        esp_timer_stop(s_verify_timer);
        ESP_LOGI(TAG, "firmware marked valid");
    } else {
        ESP_LOGE(TAG, "mark valid failed: %s", esp_err_to_name(err));
    }
}

int ota_gatt_init(uint8_t board_id)
{
    s_board_id = board_id;
    timers_init();
    if (psa_crypto_init() != PSA_SUCCESS) {
        ESP_LOGE(TAG, "psa_crypto_init failed");
        return -1;
    }
    ble_svc_gap_init();
    ble_svc_gatt_init();
    int rc = ble_gatts_count_cfg(s_services);
    if (rc == 0) {
        rc = ble_gatts_add_svcs(s_services);
    }
    return rc;
}

void ota_on_connect(uint16_t conn_handle)
{
    s_conn = conn_handle;
    s_ctrl_subscribed = false;
    esp_timer_start_once(s_idle_timer, IDLE_TIMEOUT_US);

    /* ask for a fast link; all best-effort (the central decides) */
    struct ble_gap_upd_params params = {
        .itvl_min = 6, .itvl_max = 12,  /* 7.5-15 ms */
        .latency = 0, .supervision_timeout = 400,  /* 4 s */
    };
    int rc = ble_gap_update_params(conn_handle, &params);
    int rc_phy = ble_gap_set_prefered_le_phy(conn_handle, BLE_GAP_LE_PHY_1M_MASK | BLE_GAP_LE_PHY_2M_MASK,
                                             BLE_GAP_LE_PHY_1M_MASK | BLE_GAP_LE_PHY_2M_MASK, 0);
    int rc_dl = ble_gap_set_data_len(conn_handle, 251, 2120);
    ESP_LOGI(TAG, "connected (conn %u): params rc=%d phy rc=%d datalen rc=%d", conn_handle, rc, rc_phy, rc_dl);
}

void ota_on_disconnect(void)
{
    reset_transfer("disconnected");
    s_conn = BLE_HS_CONN_HANDLE_NONE;
    s_ctrl_subscribed = false;
    esp_timer_stop(s_idle_timer);
}

void ota_on_subscribe(uint16_t attr_handle, bool notify)
{
    if (attr_handle == s_ctrl_handle) {
        s_ctrl_subscribed = notify;
    }
}
