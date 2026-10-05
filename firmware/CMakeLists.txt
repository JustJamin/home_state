cmake_minimum_required(VERSION 3.16)

# Which node app to build: single-blink, double-blink, or hs_advertiser (legacy bridge).
# The project name is the app name (it's what nodes and the catalogue call it).
#   idf.py -B build-double-blink -DHS_APP=double-blink build
set(HS_APP "single-blink" CACHE STRING "home_state node app (firmware/apps/<app>)")
if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/apps/${HS_APP}/app.defaults")
    message(FATAL_ERROR "unknown HS_APP '${HS_APP}': no firmware/apps/${HS_APP}/app.defaults")
endif()
# per-app Kconfig choice on top of the shared defaults; pass -DSDKCONFIG_DEFAULTS to add more
# (it must then include both of these, e.g. for a board ID seed)
if(NOT DEFINED SDKCONFIG_DEFAULTS)
    set(SDKCONFIG_DEFAULTS "sdkconfig.defaults;apps/${HS_APP}/app.defaults")
endif()
# keep each build directory's sdkconfig separate, so apps can't leak settings into each other
if(NOT DEFINED SDKCONFIG)
    set(SDKCONFIG "${CMAKE_BINARY_DIR}/sdkconfig")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(${HS_APP})
