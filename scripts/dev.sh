#!/usr/bin/env bash
# Start the backend for local development:
#   science (FastAPI) on :8091 and gateway (Go) on :8080.
# Usage: scripts/dev.sh            (Ctrl+C stops both)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CACHE_DIR="${CACHE_DIR:-$ROOT/.cache}"
export SCIENCE_URL="${SCIENCE_URL:-http://localhost:8091}"
export PORT="${PORT:-8080}"
export CACHE_MAX_MB="${CACHE_MAX_MB:-1500}"
UV="${UV:-$HOME/.local/bin/uv}"
mkdir -p "$CACHE_DIR"

if [ ! -x "$ROOT/science/.venv/bin/python" ]; then
  echo "creating science/.venv (Python 3.12)"
  "$UV" venv --python 3.12 "$ROOT/science/.venv"
  "$UV" pip install --python "$ROOT/science/.venv/bin/python" -r "$ROOT/science/requirements.txt"
fi

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

(cd "$ROOT/science" && exec .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8091 --workers 1) &
pids+=($!)

(cd "$ROOT/gateway" && go build -o "$ROOT/gateway/bin/gateway" . && exec "$ROOT/gateway/bin/gateway") &
pids+=($!)

echo "science :8091, gateway :$PORT, cache $CACHE_DIR"
wait -n "${pids[@]}"
