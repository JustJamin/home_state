#!/bin/sh
# Install home_state's k3s host config on lenovo and restart k3s.
# Run with: sudo sh ~/repo/home_state/deploy/k3s/apply.sh
# Running pods are not killed by the k3s restart (KillMode=process).
# Safety: if k3s restarts by itself after this (crash loop), the kubelet drop-in is removed again.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"
KUBELET_DROPIN=/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/50-graceful-shutdown.conf

install -Dm644 "$DIR/config.yaml"                    /etc/rancher/k3s/config.yaml
install -Dm644 "$DIR/k3s-after-docker.conf"          /etc/systemd/system/k3s.service.d/10-after-docker.conf
install -Dm644 "$DIR/logind-inhibit-delay.conf"      /etc/systemd/logind.conf.d/20-inhibit-delay.conf
install -Dm600 "$DIR/kubelet-graceful-shutdown.conf" "$KUBELET_DROPIN"

systemctl daemon-reload
systemctl reload systemd-logind || systemctl restart systemd-logind
systemctl restart k3s

wait_ready() {
  i=0
  until k3s kubectl get nodes 2>/dev/null | grep -q ' Ready'; do
    i=$((i+1)); [ "$i" -le 36 ] || return 1
    sleep 5
  done
}
if wait_ready; then sleep 45; fi
R=$(systemctl show k3s -p NRestarts --value)
if [ "$R" != 0 ] || ! k3s kubectl get nodes 2>/dev/null | grep -q ' Ready'; then
  echo "!!! k3s unhealthy (restarts=$R) — removing kubelet drop-in and restarting" >&2
  journalctl -u k3s -n 200 --no-pager | grep -iE 'level=error|fatal|kubelet exited' | tail -5 >&2 || true
  rm -f "$KUBELET_DROPIN"; systemctl restart k3s; wait_ready || true
  echo "k3s: $(systemctl is-active k3s), restarts=$(systemctl show k3s -p NRestarts --value)" >&2
  exit 1
fi

echo "--- k3s: $(systemctl is-active k3s), restarts=$R"
echo "--- kubelet shutdown config:"
k3s kubectl get --raw /api/v1/nodes/lenovo/proxy/configz \
  | grep -oE '"shutdownGracePeriod(CriticalPods)?":"[^"]*"' || echo "WARNING: not visible in configz"
echo "--- logind InhibitDelayMaxUSec: $(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager InhibitDelayMaxUSec)"
echo "--- inhibitors (expect kubelet, delay):"; systemd-inhibit --list --no-pager | grep -i kubelet || echo "WARNING: no kubelet inhibitor"
echo "--- k3s After=: $(systemctl show k3s -p After --value | tr ' ' '\n' | grep -x docker.service || echo MISSING)"
command -v etckeeper >/dev/null && etckeeper commit "k3s: home_state host config (graceful shutdown 60s, after docker, logind delay 90s)" || true
