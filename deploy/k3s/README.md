# k3s host config (lenovo)

Settings for the single-node k3s that runs home_state. They live here so the cluster config is versioned with the workloads.
Installing k3s itself, the firewall, and other OS setup stay in `~/repo/sysadmin` (`scripts/install-k3s.sh` reads `config.yaml` from here).

| File | Installed to | Why |
|---|---|---|
| `config.yaml` | `/etc/rancher/k3s/config.yaml` | traefik + servicelb off and NodePorts on 127.0.0.1 + the tailnet IP only, because servicelb and NodePort NAT bypass ufw |
| `kubelet-graceful-shutdown.conf` | `/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/50-graceful-shutdown.conf` | stop pods properly on poweroff (Postgres shuts down cleanly) |
| `logind-inhibit-delay.conf` | `/etc/systemd/logind.conf.d/zz-k3s-inhibit-delay.conf` | let kubelet delay shutdown for up to 90 s. The `zz-` name matters: unattended-upgrades ships a 30 s cap in `/usr/lib/systemd/logind.conf.d/`, and these drop-ins are merged in filename order, so the last one wins |
| `k3s-after-docker.conf` | `/etc/systemd/system/k3s.service.d/10-after-docker.conf` | start k3s after Docker, so the `localhost:5000` registry is up for image pulls |

Apply after changing any of them:

```sh
sudo sh ~/repo/home_state/deploy/k3s/apply.sh
```

It restarts k3s, but running pods keep running. If k3s starts crash-looping afterwards, the script removes the kubelet drop-in again.

**The graceful shutdown settings must not be `kubelet-arg` flags.** In k8s 1.36 they only exist in the config file. As flags they made k3s crash-loop on 2026-10-05.
