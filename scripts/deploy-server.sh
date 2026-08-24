#!/usr/bin/env bash
# Push-based deploy for server/ to the Hetzner VPS. Replaces VPS git-pull -
# the VPS never needs GitHub credentials. Syncs source only (not
# node_modules/.env), installs deps remotely, restarts the systemd service.
set -euo pipefail

HOST=hetzner
REMOTE_DIR=/home/scraper/buy-and-sell-ai

# No trailing slash on src/server - keeps them as named subdirs at the
# destination instead of dumping their contents into REMOTE_DIR directly.
rsync -az --delete \
  --exclude 'node_modules/' \
  --exclude '.env' --exclude '.env.*' \
  --exclude 'dist/' \
  --exclude 'data/' \
  --exclude '*.log' \
  src server package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json \
  "$HOST:$REMOTE_DIR/"

ssh "$HOST" "cd $REMOTE_DIR && pnpm install --frozen-lockfile && chown -R scraper:scraper $REMOTE_DIR/src $REMOTE_DIR/server $REMOTE_DIR/node_modules && systemctl restart buy-and-sell-server"

echo "deployed. verifying..."
sleep 1
ssh "$HOST" "systemctl is-active buy-and-sell-server"
