#!/usr/bin/env bash
# One-time server setup for Ubuntu 22.04/24.04 (Oracle Always Free: A1.Flex or E2.1.Micro).
# Installs Node 24, ffmpeg and Caddy (automatic HTTPS), opens ports 80/443 in the
# instance firewall, adds swap on small machines, and installs the kudilens service.
# Usage (on the server): sudo bash setup-server.sh <domain>
set -euo pipefail
DOMAIN="${1:?usage: setup-server.sh <domain, e.g. 1-2-3-4.sslip.io>}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl gnupg ffmpeg rsync python3-venv netfilter-persistent iptables-persistent debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [[ "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# Oracle's Ubuntu images block everything except SSH in iptables, even when the VCN allows it.
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 5 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
done
netfilter-persistent save

# Small machines (1 GB) need swap for ffmpeg and npm-free Node.
if [[ $(free -m | awk '/Mem:/{print $2}') -lt 4000 && ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -d -o ubuntu -g ubuntu -m 755 /opt/kudilens
install -d -o ubuntu -g ubuntu -m 700 /opt/kudilens/data

cat > /etc/systemd/system/kudilens.service <<UNIT
[Unit]
Description=KudiLens bot (Telegram, WhatsApp, Passport)
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/opt/kudilens
ExecStart=/usr/bin/node --env-file=/opt/kudilens/.env --disable-warning=ExperimentalWarning src/main.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/kudilens/data
MemoryMax=700M

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
CADDY

systemctl daemon-reload
systemctl enable kudilens caddy
systemctl restart caddy
echo "Server ready. Deploy the code with deploy/deploy.sh from your PC."
