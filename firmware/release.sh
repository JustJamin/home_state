#!/bin/bash
# Build every node app and publish them to the provisioning dashboard.
#
#   firmware/release.sh          release: HEAD must be tagged (vX.Y.Z) and the tree clean
#   firmware/release.sh --dev    test build: any HEAD, version from git describe (may be -dirty)
#
# Apps are the directories in firmware/apps/ (single-blink, double-blink, hs_advertiser...).
# Each is built in firmware/build-<app>/ and published as the catalogue entry <app>/<version>/:
#   firmware.bin          the app image
#   default.config.json   the app's default config script (apps/<app>/default.json)
#   methods.json          the app's JSON-RPC param schemas (apps/<app>/methods.json)
# into dashboards/fastapi-sse/firmware/ (gitignored, baked into the dashboard image) and
# ~/home_state-firmware/ (the durable copy on lenovo). Then run
# deploy/push-dashboards.sh fastapi-sse.
set -eu
cd "$(dirname "$0")"
repo=$(git rev-parse --show-toplevel)

if [ "${1:-}" = "--dev" ]; then
    ver=$(git describe --tags --always --dirty)
else
    if [ -n "$(git -C "$repo" status --porcelain)" ]; then
        echo "working tree is dirty: commit first (or use --dev)" >&2
        exit 1
    fi
    if ! ver=$(git describe --tags --exact-match 2>/dev/null); then
        echo "HEAD is not tagged: tag the release first, e.g. git tag -a v1.3.1 (or use --dev)" >&2
        exit 1
    fi
fi

python3 "$repo/tools/app_config.py" --check  # per-app methods/default files must match their sources

# export.sh can't find itself when sourced from a script, so point it at IDF explicitly
export IDF_PATH=${IDF_PATH:-$HOME/esp/esp-idf}
if ! . "$IDF_PATH/export.sh" >/dev/null; then
    echo "failed to load ESP-IDF from $IDF_PATH" >&2
    exit 1
fi

for appdir in apps/*/; do
    app=$(basename "$appdir")
    build=build-$app
    echo "=== $app $ver"
    # PROJECT_VER (git describe) is only read at configure time
    idf.py -B "$build" -DHS_APP="$app" reconfigure >/dev/null
    idf.py -B "$build" -DHS_APP="$app" build >/dev/null
    read -r proj built < <(python3 -c "
import sys; d = open(sys.argv[1], 'rb').read()
f = lambda o: d[o:o + 32].split(b'\0')[0].decode()
print(f(80), f(48))" "$build/$app.bin")
    if [ "$proj" != "$app" ] || [ "$built" != "$ver" ]; then
        echo "$build/$app.bin is $proj $built, expected $app $ver" >&2
        exit 1
    fi
    if ! python3 -c "import sys; sys.exit(b'HOMESTATE-NODE-FAMILY:1' not in open(sys.argv[1], 'rb').read())" "$build/$app.bin"; then
        echo "$app.bin has no node-family marker: nodes would refuse it" >&2
        exit 1
    fi
    for root in "$repo/dashboards/fastapi-sse/firmware" "$HOME/home_state-firmware"; do
        dir=$root/$app/$ver
        mkdir -p "$dir"
        cp "$build/$app.bin" "$dir/firmware.bin"
        cp "$appdir/default.json" "$dir/default.config.json"
        cp "$appdir/methods.json" "$dir/methods.json"
    done
    echo "published $app/$ver ($(stat -c %s "$build/$app.bin") bytes, sha256 $(sha256sum "$build/$app.bin" | cut -c1-16)…)"
done
echo "next: deploy/push-dashboards.sh fastapi-sse"
