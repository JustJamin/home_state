idf_component_register(SRCS "main.c" "ota.c"
                       PRIV_REQUIRES bt nvs_flash esp_driver_tsens app_update esp_timer esp_app_format mbedtls)
