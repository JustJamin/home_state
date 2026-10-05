/*
 * JSON-RPC 2.0 for hs_advertiser (spec: docs/jsonrpc.md). Transport-agnostic:
 * USB serial (rpc_usb.c) and BLE (ota.c's RPC characteristic) both call
 * rpc_handle(). Method params are described in firmware/config/methods.json.
 */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_chip_info.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "hs.h"
#include "ota.h"

#define METHODS_VERSION 1

enum {
    ERR_PARSE = -32700, ERR_INVALID_REQUEST = -32600, ERR_METHOD = -32601,
    ERR_PARAMS = -32602, ERR_INTERNAL = -32603,
};

typedef struct {
    int code;
    char message[96];
    char field[40];
} rpc_error_t;

typedef cJSON *(*rpc_fn)(const cJSON *params, rpc_error_t *err);

static cJSON *params_error(rpc_error_t *err, const char *field, const char *msg)
{
    err->code = ERR_PARAMS;
    snprintf(err->field, sizeof(err->field), "%s", field);
    snprintf(err->message, sizeof(err->message), "%s", msg);
    return NULL;
}

static bool no_params(const cJSON *params, rpc_error_t *err)
{
    if (params && !(cJSON_IsObject(params) && cJSON_GetArraySize(params) == 0) &&
        !(cJSON_IsArray(params) && cJSON_GetArraySize(params) == 0)) {
        params_error(err, "", "this method takes no params");
        return false;
    }
    return true;
}

/* ---- methods ---- */

/* Device ID: the factory MAC burned into eFuse (6 bytes, never changes).
 * Not esp_efuse_mac_get_default(): on the C6 that returns the 8-byte EUI-64. */
static void device_id(char *out, size_t len)
{
    uint8_t mac[8] = {0};
    esp_read_mac(mac, ESP_MAC_EFUSE_FACTORY);
    snprintf(out, len, "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

static cJSON *m_device_info(const cJSON *params, rpc_error_t *err)
{
    if (!no_params(params, err)) {
        return NULL;
    }
    const esp_app_desc_t *app = esp_app_get_description();
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    char id[16];
    device_id(id, sizeof(id));
    char rev[8];
    snprintf(rev, sizeof(rev), "v%d.%d", chip.revision / 100, chip.revision % 100);

    cJSON *r = cJSON_CreateObject();
    cJSON_AddStringToObject(r, "device_id", id);
    cJSON_AddStringToObject(r, "app", app->project_name);
    cJSON_AddStringToObject(r, "version", app->version);
    cJSON_AddStringToObject(r, "idf", app->idf_ver);
    cJSON_AddStringToObject(r, "chip", CONFIG_IDF_TARGET);
    cJSON_AddStringToObject(r, "chip_rev", rev);
    cJSON_AddNumberToObject(r, "board_id", hs_board_id());
    cJSON_AddNumberToObject(r, "methods_version", METHODS_VERSION);
    ota_add_info(r); /* partition, state, rolled_back_from */
    return r;
}

static const char *reset_reason(void)
{
    switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "interrupt_watchdog";
    case ESP_RST_TASK_WDT: return "task_watchdog";
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_USB: return "usb";
    case ESP_RST_JTAG: return "jtag";
    default: return "other";
    }
}

static cJSON *m_device_status(const cJSON *params, rpc_error_t *err)
{
    if (!no_params(params, err)) {
        return NULL;
    }
    cJSON *r = cJSON_CreateObject();
    cJSON_AddNumberToObject(r, "uptime_s", (double)(esp_timer_get_time() / 1000000));
    cJSON_AddNumberToObject(r, "free_heap", esp_get_free_heap_size());
    cJSON_AddNumberToObject(r, "min_free_heap", esp_get_minimum_free_heap_size());
    cJSON_AddStringToObject(r, "reset_reason", reset_reason());
    float t = hs_temp_c();
    if (isnan(t)) {
        cJSON_AddNullToObject(r, "temp_c");
    } else {
        cJSON_AddNumberToObject(r, "temp_c", roundf(t * 100) / 100);
    }
    cJSON_AddNumberToObject(r, "counter", hs_counter());
    cJSON_AddBoolToObject(r, "ble_connected", hs_connected());
    return r;
}

static cJSON *m_config_get(const cJSON *params, rpc_error_t *err)
{
    return no_params(params, err) ? settings_to_json() : NULL;
}

static cJSON *m_config_set(const cJSON *params, rpc_error_t *err)
{
    char msg[64], field[40];
    if (!settings_apply(params, msg, sizeof(msg), field, sizeof(field))) {
        return params_error(err, field, msg);
    }
    cJSON *r = cJSON_CreateObject();
    cJSON_AddItemToObject(r, "config", settings_to_json());
    cJSON_AddBoolToObject(r, "reboot_required", false); /* all v1 settings apply live */
    return r;
}

static cJSON *m_config_reset(const cJSON *params, rpc_error_t *err)
{
    if (!no_params(params, err)) {
        return NULL;
    }
    settings_reset();
    return settings_to_json();
}

static cJSON *m_board_set_id(const cJSON *params, rpc_error_t *err)
{
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(params, "id");
    if (!cJSON_IsNumber(id) || id->valuedouble != (int)id->valuedouble) {
        return params_error(err, "id", "must be an integer");
    }
    if (id->valueint < 0 || id->valueint > 255) {
        return params_error(err, "id", "must be between 0 and 255");
    }
    if (!hs_set_board_id((uint8_t)id->valueint)) {
        err->code = ERR_INTERNAL;
        snprintf(err->message, sizeof(err->message), "failed to store board ID");
        return NULL;
    }
    cJSON *r = cJSON_CreateObject();
    cJSON_AddNumberToObject(r, "board_id", hs_board_id());
    return r;
}

static cJSON *m_device_identify(const cJSON *params, rpc_error_t *err)
{
    double seconds = 10;
    const cJSON *s = cJSON_GetObjectItemCaseSensitive(params, "seconds");
    if (s) {
        if (!cJSON_IsNumber(s) || s->valuedouble < 1 || s->valuedouble > 300) {
            return params_error(err, "seconds", "must be a number between 1 and 300");
        }
        seconds = s->valuedouble;
    }
    led_identify((uint32_t)seconds);
    cJSON *r = cJSON_CreateObject();
    cJSON_AddNumberToObject(r, "seconds", (uint32_t)seconds);
    return r;
}

static cJSON *m_device_reboot(const cJSON *params, rpc_error_t *err)
{
    if (!no_params(params, err)) {
        return NULL;
    }
    hs_restart_after(300); /* let the response go out first */
    cJSON *r = cJSON_CreateObject();
    cJSON_AddBoolToObject(r, "rebooting", true);
    return r;
}

static cJSON *m_ota_status(const cJSON *params, rpc_error_t *err)
{
    return no_params(params, err) ? ota_status_json() : NULL;
}

static cJSON *m_rpc_discover(const cJSON *params, rpc_error_t *err);

static const struct {
    const char *name;
    rpc_fn fn;
} METHODS[] = {
    {"rpc.discover", m_rpc_discover},
    {"device.info", m_device_info},
    {"device.status", m_device_status},
    {"device.identify", m_device_identify},
    {"device.reboot", m_device_reboot},
    {"config.get", m_config_get},
    {"config.set", m_config_set},
    {"config.reset", m_config_reset},
    {"board.set_id", m_board_set_id},
    {"ota.status", m_ota_status},
};

static cJSON *m_rpc_discover(const cJSON *params, rpc_error_t *err)
{
    cJSON *r = cJSON_CreateObject();
    cJSON_AddNumberToObject(r, "methods_version", METHODS_VERSION);
    cJSON *list = cJSON_AddArrayToObject(r, "methods");
    for (size_t i = 0; i < sizeof(METHODS) / sizeof(METHODS[0]); i++) {
        cJSON_AddItemToArray(list, cJSON_CreateString(METHODS[i].name));
    }
    return r;
}

/* ---- dispatch ---- */

static char *respond(cJSON *id, cJSON *result, const rpc_error_t *err)
{
    cJSON *resp = cJSON_CreateObject();
    cJSON_AddStringToObject(resp, "jsonrpc", "2.0");
    if (err) {
        cJSON *e = cJSON_AddObjectToObject(resp, "error");
        cJSON_AddNumberToObject(e, "code", err->code);
        cJSON_AddStringToObject(e, "message", err->message);
        if (err->field[0]) {
            cJSON *data = cJSON_AddObjectToObject(e, "data");
            cJSON_AddStringToObject(data, "field", err->field);
        }
    } else {
        cJSON_AddItemToObject(resp, "result", result);
    }
    cJSON_AddItemToObject(resp, "id", id ? cJSON_Duplicate(id, true) : cJSON_CreateNull());
    char *out = cJSON_PrintUnformatted(resp);
    cJSON_Delete(resp);
    return out;
}

char *rpc_handle(const char *request, size_t len)
{
    rpc_error_t err = {0};
    cJSON *req = cJSON_ParseWithLength(request, len);
    if (!req) {
        err.code = ERR_PARSE;
        snprintf(err.message, sizeof(err.message), "parse error");
        return respond(NULL, NULL, &err);
    }

    const cJSON *ver = cJSON_GetObjectItemCaseSensitive(req, "jsonrpc");
    const cJSON *method = cJSON_GetObjectItemCaseSensitive(req, "method");
    cJSON *id = cJSON_GetObjectItemCaseSensitive(req, "id");
    const cJSON *params = cJSON_GetObjectItemCaseSensitive(req, "params");
    char *out = NULL;

    if (!cJSON_IsObject(req) || !cJSON_IsString(ver) || strcmp(ver->valuestring, "2.0") != 0 ||
        !cJSON_IsString(method) || (params && !cJSON_IsObject(params) && !cJSON_IsArray(params))) {
        err.code = ERR_INVALID_REQUEST;
        snprintf(err.message, sizeof(err.message), "invalid request");
        out = respond(id, NULL, &err);
        goto done;
    }

    rpc_fn fn = NULL;
    for (size_t i = 0; i < sizeof(METHODS) / sizeof(METHODS[0]); i++) {
        if (strcmp(METHODS[i].name, method->valuestring) == 0) {
            fn = METHODS[i].fn;
        }
    }
    if (!fn) {
        err.code = ERR_METHOD;
        snprintf(err.message, sizeof(err.message), "method not found: %.60s", method->valuestring);
        out = id ? respond(id, NULL, &err) : NULL;
        goto done;
    }

    ESP_LOGI("rpc", "%s", method->valuestring);
    cJSON *result = fn(params, &err);
    if (!id) { /* notification: run it, send nothing */
        cJSON_Delete(result);
        goto done;
    }
    out = result ? respond(id, result, NULL) : respond(id, NULL, &err);

done:
    cJSON_Delete(req);
    return out;
}
