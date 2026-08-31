#!/usr/bin/env bash
# Push-based deploy for server/ to the Hetzner VPS. Replaces VPS git-pull -
# the VPS never needs GitHub credentials. Syncs source only (not
# node_modules/.env), installs deps remotely, restarts the systemd service.
set -euo pipefail

HOST=hetzner
REMOTE_DIR=/home/scraper/buy-and-sell-ai

# Mirrors server/routes/workerControl.ts's WORKER_PID_FILES keys - kept in
# sync by hand, same tradeoff as the dashboard's own WORKERS array (no
# shared import path between this script and the TS source).
WORKERS="collect check-listings extract-products enrich-products price-lookup enrich-listing-prices verify-discount-notifications"

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

# CI=true: pnpm otherwise prompts interactively (no TTY over this ssh
# exec) to confirm purging node_modules on a lockfile/structure mismatch -
# confirmed live, hit on every single deploy this session without it.
ssh "$HOST" "cd $REMOTE_DIR && CI=true pnpm install --frozen-lockfile && chown -R scraper:scraper $REMOTE_DIR/src $REMOTE_DIR/server $REMOTE_DIR/node_modules && systemctl restart buy-and-sell-server"

echo "deployed. verifying..."
sleep 1
ssh "$HOST" "systemctl is-active buy-and-sell-server"

# systemctl restart uses systemd's default cgroup-wide kill, which SIGKILLs
# every detached worker child too (Node's own detached+unref only detaches
# at the OS process-group level, not from the service's systemd cgroup) -
# confirmed live 2026-08-31: every worker silently died on every deploy this
# session, several times going unnoticed until the next status check. Start
# them all back up here instead of relying on a human to remember.
echo "restarting workers..."
API_KEY=$(ssh "$HOST" "grep '^REFRESH_API_KEY' $REMOTE_DIR/server/.env | cut -d'\"' -f2")
for w in $WORKERS; do
  ssh "$HOST" "curl -s -X POST http://localhost:8787/worker-control -H 'Authorization: Bearer $API_KEY' -H 'Content-Type: application/json' -d '{\"worker\":\"$w\",\"action\":\"start\"}'"
  echo " <- $w"
done
