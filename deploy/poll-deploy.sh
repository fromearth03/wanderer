#!/usr/bin/env bash
# Pull-based continuous deployment for Wanderer.
#
# Runs on the server every 2 minutes (systemd timer, see deploy/README.md).
# 1. Fetch origin/main.
# 2. If there is a new commit AND GitHub Actions CI passed for it, check it out
#    and rebuild the containers.
# 3. Health-check the live site; if it fails, roll back to the previous commit.
#
# Nothing secret is stored on GitHub: the server pulls a public repository.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/wanderer}"
BRANCH="${BRANCH:-main}"
GH_REPO="${GH_REPO:-fromearth03/wanderer}"
HEALTH_URL="${HEALTH_URL:-https://wanderer.stellar-trace.tech/api/health}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)
STATE_DIR="${STATE_DIR:-$HOME/.wanderer-deploy}"
mkdir -p "$STATE_DIR"

log() { echo "$(date -u +%FT%TZ) $*"; }

# One run at a time.
exec 9>"$STATE_DIR/lock"
flock -n 9 || { log "another deploy is running"; exit 0; }

cd "$REPO_DIR"
git fetch --quiet origin "$BRANCH"
current="$(git rev-parse HEAD)"
target="$(git rev-parse "origin/$BRANCH")"
[ "$current" = "$target" ] && exit 0

# Skip a commit we already tried and rolled back.
if [ -f "$STATE_DIR/bad" ] && grep -qx "$target" "$STATE_DIR/bad"; then exit 0; fi

# Only deploy commits whose CI checks all completed successfully.
runs="$(curl -fsS -m 20 -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$GH_REPO/commits/$target/check-runs?per_page=50")" || { log "GitHub API unreachable"; exit 0; }
verdict="$(printf '%s' "$runs" | python3 -c '
import json, sys
runs = json.load(sys.stdin).get("check_runs", [])
if not runs: print("none")
elif any(r["status"] != "completed" for r in runs): print("pending")
elif all(r["conclusion"] in ("success", "skipped", "neutral") for r in runs): print("success")
else: print("failure")')"
case "$verdict" in
  success) ;;
  pending|none) log "CI not finished for ${target:0:7}, waiting"; exit 0 ;;
  *) log "CI failed for ${target:0:7}, not deploying"; echo "$target" >> "$STATE_DIR/bad"; exit 0 ;;
esac

log "deploying ${current:0:7} -> ${target:0:7}"
git checkout --quiet --force "$target"
if sudo "${COMPOSE[@]}" up -d --build --remove-orphans; then
  for i in $(seq 1 30); do
    if curl -fsS -m 10 "$HEALTH_URL" | grep -q '"ok":true'; then
      log "deployed ${target:0:7}, healthy"
      echo "$target" > "$STATE_DIR/deployed"
      exit 0
    fi
    sleep 10
  done
fi

log "deploy of ${target:0:7} unhealthy, rolling back to ${current:0:7}"
echo "$target" >> "$STATE_DIR/bad"
git checkout --quiet --force "$current"
sudo "${COMPOSE[@]}" up -d --build --remove-orphans
exit 1
