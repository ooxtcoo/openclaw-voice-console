#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Config
export OPENCLAW_URL="${OPENCLAW_URL:-ws://127.0.0.1:18789}"
export OPENCLAW_SESSION="${OPENCLAW_SESSION:-voice}"
export VOICE_PORT="${VOICE_PORT:-4888}"

if [[ -z "${OPENCLAW_TOKEN:-}" ]]; then
  echo "ERROR: OPENCLAW_TOKEN is required."
  echo "Set it like: export OPENCLAW_TOKEN=..."
  exit 2
fi

echo "Starting OpenClaw Voice Console (Linux)"
echo "  OPENCLAW_URL=$OPENCLAW_URL"
echo "  OPENCLAW_SESSION=$OPENCLAW_SESSION"
echo "  VOICE_PORT=$VOICE_PORT"

# Edge TTS dependency check
if ! python3 -c "import edge_tts" >/dev/null 2>&1; then
  echo "edge-tts not found. Install with:"
  echo "  python3 -m pip install --user --upgrade edge-tts"
fi

cd "$ROOT_DIR"
node node_server.mjs
