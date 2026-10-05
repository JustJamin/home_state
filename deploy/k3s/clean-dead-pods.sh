#!/bin/sh
# Delete pods left Completed/Error by graceful node shutdown, after k3s comes up.
# Only pods owned by a ReplicaSet/StatefulSet/DaemonSet (their controller always runs a replacement,
# so a terminated one is pure clutter). Job pods and bare pods are kept: their Failed status
# and logs may be real evidence.
# Installed to /usr/local/sbin/k3s-clean-dead-pods; run at boot by k3s-clean-dead-pods.service.
# Manual: sudo k3s-clean-dead-pods   (DRY_RUN=1 to only list)
set -eu
KUBECTL="k3s kubectl"

# Wait up to 5 min for the API server.
i=0
until $KUBECTL get --raw /readyz >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -le 60 ] || { echo "API not ready after 5 min, giving up" >&2; exit 1; }
  sleep 5
done

$KUBECTL get pods -A --field-selector='status.phase!=Running,status.phase!=Pending,status.phase!=Unknown' \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" "}{.status.phase}{" "}{.metadata.ownerReferences[0].kind}{"\n"}{end}' \
| while read -r ns name phase owner; do
    case "$owner" in
      ReplicaSet|StatefulSet|DaemonSet)
        if [ "${DRY_RUN:-0}" = 1 ]; then echo "would delete $ns/$name ($phase, $owner)"
        else $KUBECTL -n "$ns" delete pod "$name" --wait=false && echo "deleted $ns/$name ($phase, $owner)"; fi ;;
      *) echo "kept $ns/$name ($phase, owner=${owner:-none})" ;;
    esac
  done
