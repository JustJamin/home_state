/*
 * JSON-RPC over USB serial: one request per line in, one response per line out.
 * The same port carries the log, so clients ignore lines that aren't JSON
 * objects with "jsonrpc" in them.
 */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "hs.h"

#define RPC_LINE_MAX 4096

static void rpc_usb_task(void *arg)
{
    char *line = malloc(RPC_LINE_MAX);
    size_t len = 0;
    bool overflow = false;
    for (;;) {
        int c = fgetc(stdin);
        if (c == EOF) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        if (c == '\r') {
            continue;
        }
        if (c != '\n') {
            if (len < RPC_LINE_MAX - 1) {
                line[len++] = (char)c;
            } else {
                overflow = true;
            }
            continue;
        }
        if (overflow) {
            printf("{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32600,\"message\":\"request too long\"},\"id\":null}\n");
        } else if (len > 0 && line[0] == '{') {
            char *resp = rpc_handle(line, len);
            if (resp) {
                printf("%s\n", resp); /* one printf so log lines can't split it */
                fflush(stdout);
                cJSON_free(resp);
            }
        }
        len = 0;
        overflow = false;
    }
}

void rpc_usb_start(void)
{
    usb_serial_jtag_driver_config_t cfg = {
        .tx_buffer_size = 1024,
        .rx_buffer_size = 1024,
    };
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&cfg));
    usb_serial_jtag_vfs_use_driver();
    usb_serial_jtag_vfs_set_rx_line_endings(ESP_LINE_ENDINGS_LF);
    usb_serial_jtag_vfs_set_tx_line_endings(ESP_LINE_ENDINGS_LF);
    fcntl(fileno(stdin), F_SETFL, 0); /* blocking reads */
    fcntl(fileno(stdout), F_SETFL, 0);
    setvbuf(stdin, NULL, _IONBF, 0);
    xTaskCreate(rpc_usb_task, "rpc_usb", 6144, NULL, 4, NULL);
}
