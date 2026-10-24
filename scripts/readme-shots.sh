#!/usr/bin/env bash
# Rebuild the two offline workspaces, capture six views each, then stop the server.
set -euo pipefail
export npm_config_offline=true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PYTHON="$ROOT/.venv/bin/python"
PORT="${E2E_PORT:-8776}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ora-readme-shots.XXXXXX")"
SERVER_PID=""

stop_server() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

cleanup() {
  stop_server
  # Only this invocation's mktemp directory is removed.
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Fail before starting anything if this port belongs to another service.
"$PYTHON" - "$PORT" <<'PY'
import socket
import sys
with socket.socket() as sock:
    sock.bind(("127.0.0.1", int(sys.argv[1])))
PY

cd "$ROOT/frontend"
npm run build
cd "$ROOT"

for LANG_CODE in zh en; do
  DATA="$WORK/$LANG_CODE"
  "$PYTHON" scripts/demo_workspace.py --data "$DATA" --lang "$LANG_CODE"
  # No Pi installation, public metadata lookup, or ambient model credentials.
  OPR_HOME="$DATA" \
    AGENT_NODE="$DATA/no-node" \
    PLATFORM_MODEL_CONFIG="$DATA/platform-model.json" \
    TRANSLATION_CONFIG_DIR="$DATA/translation-credentials" \
    SCHOLAR_OFFLINE=1 \
    "$PYTHON" -m backend.local.cli --data "$DATA" --port "$PORT" --no-browser \
    >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!

  if ! "$PYTHON" - "$PORT" "$SERVER_PID" <<'PY'
import os
import sys
import time
import urllib.request

for _ in range(150):
    os.kill(int(sys.argv[2]), 0)
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{sys.argv[1]}/api/v1/health", timeout=1
        ) as response:
            if response.status == 200:
                break
    except OSError:
        time.sleep(0.2)
else:
    raise SystemExit("Local demo server did not become ready")
PY
  then
    cat "$WORK/server.log"
    exit 1
  fi

  (
    cd "$ROOT/frontend"
    README_SHOTS=1 README_SHOTS_DATA="$DATA" README_SHOTS_LANG="$LANG_CODE" \
      E2E_PORT="$PORT" npx playwright test e2e/readme-shots.spec.ts --workers=1
  )
  stop_server
done

echo "README screenshots: $ROOT/docs/images/{home,team,research,project,library,reader}.{zh,en}.png"
