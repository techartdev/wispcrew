#!/usr/bin/env bash
#
# Publish the landing page to the host that serves wispcrew.app.
#
# The site is static, so deployment is a copy and a Caddy reload. Kept in the
# repository rather than as remembered commands: a deploy nobody can read is a
# deploy only one person can do.
#
#   ./site/deploy.sh
#
set -euo pipefail

HOST="${WISPCREW_HOST:-root@49.13.19.149}"
REMOTE="/opt/hosting/sites/wispcrew.app"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Deploying to ${HOST}:${REMOTE}"

# `public/` holds what is served; the Caddyfile sits beside it, matching the
# layout the other sites on this host already use.
ssh "$HOST" "mkdir -p ${REMOTE}/public"

# --delete so a removed file actually disappears, rather than lingering as an
# orphan nobody remembers publishing.
rsync -az --delete \
  --exclude 'deploy.sh' \
  --exclude 'Caddyfile' \
  "${HERE}/" "${HOST}:${REMOTE}/public/"

scp -q "${HERE}/Caddyfile" "${HOST}:${REMOTE}/Caddyfile"

# Validate BEFORE reloading: a broken Caddyfile takes down every other site on
# this machine, not just this one.
echo "Validating configuration..."
ssh "$HOST" "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" >/dev/null

echo "Reloading Caddy..."
ssh "$HOST" "systemctl reload caddy"

echo "Done. https://wispcrew.app/"
