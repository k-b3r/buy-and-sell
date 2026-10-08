#!/usr/bin/env bash
# Laptop-side SOCKS tunnel (-D 1080, local processes -> VPS's IP) + reverse
# dynamic SOCKS tunnel (-R 1080, VPS-side workers with SOCKS_PROXY set ->
# this laptop's network). An unclean disconnect (Ctrl+C, network drop,
# suspend) leaves the remote sshd-session holding port 1080 on the VPS,
# which then makes the next `-R 1080` fail with "remote port forwarding
# failed for listen port 1080" - found live 2026-08-29. Clean up both sides
# before starting a fresh one instead of hunting the stale pid by hand.
set -euo pipefail

# The VPS address comes from the `hetzner` alias in ~/.ssh/config, never this
# public repo. TUNNEL_HOST overrides it.
VPS_ADDR=$(ssh -G hetzner 2>/dev/null | awk '/^hostname /{print $2}')
TUNNEL_HOST="${TUNNEL_HOST:-tunnel@$VPS_ADDR}"
TUNNEL_KEY="$HOME/.ssh/vps_tunnel"
# ServerAliveInterval/CountMax: without these the tunnel can sit half-dead
# after a network blip (wifi switch, sleep/wake) and silently exit later with
# no error logged - confirmed live 2026-08-31, twice in one session, no
# error text either time (bare "[exited with code 0]"). 30s x 3 misses = dies
# within ~90s of actually losing the link instead of drifting unnoticed.
TUNNEL_CMD="ssh -N -D 1080 -R 1080 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -i $TUNNEL_KEY $TUNNEL_HOST"

echo "Cleaning up stale connections..."

if pkill -f -- "$TUNNEL_CMD"; then
  echo "  killed a stale local tunnel process"
else
  echo "  no stale local tunnel process"
fi

# hetzner is the root SSH alias (see ~/.ssh/config) - the restricted `tunnel`
# account this script connects as can't see/kill its own orphaned session.
ssh hetzner '
  pids=$(ss -tlnp 2>/dev/null | grep ":1080" | grep -oP "pid=\K[0-9]+" | sort -u)
  if [ -z "$pids" ]; then
    echo "  no stale remote listener on port 1080"
  else
    for pid in $pids; do
      kill "$pid" && echo "  killed stale remote listener (pid $pid)"
    done
  fi
'

echo "Starting tunnel (Ctrl+C to stop)..."
exec $TUNNEL_CMD
