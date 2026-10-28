#!/usr/bin/env bash
# Push the code and .env to the server and restart. Run from the kudilens folder:
#   deploy/deploy.sh <ssh-host> <public-ip>        e.g. deploy/deploy.sh oracle-sto 1.2.3.4
# First time: deploy/deploy.sh <ssh-host> <public-ip> --setup
set -euo pipefail
HOST="${1:?ssh host}"; IP="${2:?public ip}"; DOMAIN="${IP//./-}.sslip.io"
cd "$(dirname "$0")/.."
if [[ "${3:-}" == "--setup" ]]; then
  scp deploy/setup-server.sh "$HOST":/tmp/setup-server.sh
  ssh "$HOST" "sudo bash /tmp/setup-server.sh $DOMAIN"
fi
npm test --silent >/dev/null || { echo "tests fail; not deploying"; exit 1; }
rsync -az --delete --exclude data --exclude .env --exclude .git --exclude 'eval/private' --exclude 'eval/samples/*.png' ./ "$HOST":/opt/kudilens/
# The server's .env is the local one with the public URL set to the HTTPS domain.
sed -E "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#; s#^DATA_DIR=.*#DATA_DIR=/opt/kudilens/data#" .env | ssh "$HOST" "umask 077 && cat > /opt/kudilens/.env"
ssh "$HOST" "sudo systemctl restart kudilens && sleep 2 && systemctl is-active kudilens && curl -fsS http://127.0.0.1:8080/health && echo"
echo "Live at https://$DOMAIN  (WhatsApp webhook: https://$DOMAIN/webhook/whatsapp)"
