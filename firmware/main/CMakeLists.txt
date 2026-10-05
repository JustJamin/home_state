# the app's own LED settings and pattern (main/apps/<app>.c)
if(CONFIG_HS_APP_DOUBLE_BLINK)
    set(app_src "apps/double_blink.c")
elseif(CONFIG_HS_APP_HS_ADVERTISER)
    set(app_src "apps/hs_advertiser.c")
else()
    set(app_src "apps/single_blink.c")
endif()

idf_component_register(SRCS "main.c" "ota.c" "rpc.c" "rpc_usb.c" "settings.c" "led.c" "${app_src}"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES bt nvs_flash esp_driver_tsens esp_driver_gpio esp_driver_usb_serial_jtag
                                     app_update esp_timer esp_app_format mbedtls espressif__cjson)

# the Kconfig app and the project name (-DHS_APP) must agree, or nodes and the catalogue disagree
idf_build_get_property(project_name PROJECT_NAME)
if(CONFIG_HS_APP_NAME AND NOT CONFIG_HS_APP_NAME STREQUAL project_name)
    message(FATAL_ERROR "Kconfig app '${CONFIG_HS_APP_NAME}' doesn't match project '${project_name}'")
endif()
