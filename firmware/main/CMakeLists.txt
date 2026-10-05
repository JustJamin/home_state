idf_component_register(SRCS "main.c" "ota.c" "rpc.c" "rpc_usb.c" "settings.c" "led.c"
                       PRIV_REQUIRES bt nvs_flash esp_driver_tsens esp_driver_gpio esp_driver_usb_serial_jtag
                                     app_update esp_timer esp_app_format mbedtls espressif__cjson)
