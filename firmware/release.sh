#!/bin/bash
# Build firmware and publish it to the provisioning dashboard.
#
#   firmware/release.sh          release: HEAD must be tagged (vX.Y.Z) and the tree clean
#   firmware/release.sh --dev    test build: any HEAD, version from git describe (may be -dirty)
#
# Publishes the catalogue entry <app>/<version>/ with:
#   firmware.bin          the app image
#   default.config.json   default config script (config/default.json)
#   methods.json          JSON-RPC method schemas, for validating configs (config/methods.json)
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
        echo "HEAD is not tagged: tag the release first, e.g. git tag -a v1.1.0 (or use --dev)" >&2
        exit 1
    fi
fi

# export.sh can't find itself when sourced from a script, so point it at IDF explicitly
export IDF_PATH=${IDF_PATH:-$HOME/esp/esp-idf}
if ! . "$IDF_PATH/export.sh" >/dev/null; then
    echo "failed to load ESP-IDF from $IDF_PATH" >&2
    exit 1
fi
idf.py reconfigure >/dev/null  # PROJECT_VER (git describe) is only read at configure time
idf.py build

read -r app built < <(python3 -c "
import sys; d = open(sys.argv[1], 'rb').read()
f = lambda o: d[o:o + 32].split(b'\0')[0].decode()
print(f(80), f(48))" build/hs_advertiser.bin)
if [ "$built" != "$ver" ]; then
    echo "image reports version '$built', expected '$ver' (stale build? try idf.py reconfigure)" >&2
    exit 1
fi
for f in config/default.json config/methods.json; do
    python3 -m json.tool "$f" >/dev/null || { echo "$f is not valid JSON" >&2; exit 1; }
done

for root in "$repo/dashboards/fastapi-sse/firmware" "$HOME/home_state-firmware"; do
    dir=$root/$app/$ver
    mkdir -p "$dir"
    cp build/hs_advertiser.bin "$dir/firmware.bin"
    cp config/default.json "$dir/default.config.json"
    cp config/methods.json "$dir/methods.json"
done
echo "published $app/$ver ($(stat -c %s build/hs_advertiser.bin) bytes, sha256 $(sha256sum build/hs_advertiser.bin | cut -c1-16)…)"
echo "next: deploy/push-dashboards.sh fastapi-sse"
