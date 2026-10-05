#!/bin/sh
# Build firmware and publish it to the provisioning dashboard.
#
#   firmware/release.sh          release: HEAD must be tagged (vX.Y.Z) and the tree clean
#   firmware/release.sh --dev    test build: any HEAD, version from git describe (may be -dirty)
#
# Copies build/hs_advertiser.bin to dashboards/fastapi-sse/firmware/hs_advertiser-<version>.bin
# (gitignored) and to ~/home_state-firmware/ (the durable copy on lenovo). Then run
# deploy/push-dashboards.sh fastapi-sse to put it in the dashboard image.
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

. "${IDF_PATH:-$HOME/esp/esp-idf}/export.sh" >/dev/null
idf.py build

built=$(python3 -c "import sys; d=open(sys.argv[1],'rb').read(); print(d[48:80].split(b'\0')[0].decode())" build/hs_advertiser.bin)
if [ "$built" != "$ver" ]; then
    echo "image reports version '$built', expected '$ver' (stale build?)" >&2
    exit 1
fi

name=hs_advertiser-$ver.bin
for dir in "$repo/dashboards/fastapi-sse/firmware" "$HOME/home_state-firmware"; do
    mkdir -p "$dir"
    cp build/hs_advertiser.bin "$dir/$name"
done
echo "published $name ($(stat -c %s build/hs_advertiser.bin) bytes, sha256 $(sha256sum build/hs_advertiser.bin | cut -c1-16)…)"
echo "next: deploy/push-dashboards.sh fastapi-sse"
