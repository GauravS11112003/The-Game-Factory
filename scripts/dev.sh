#!/usr/bin/env bash
# Starts the vision API (uvicorn, :8000) and the web app (vite, :5173) and prints the LAN URL.
# Phones on the same Wi-Fi open http://<lan-ip>:5173; Vite proxies /api and /uploads to :8000.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Local secrets (ANTHROPIC_API_KEY=...) live in <root>/.env, which git ignores.
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

API_PORT="${DAL_PORT:-8000}"
WEB_PORT="${WEB_PORT:-5173}"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)"

cleanup() {
  trap - EXIT INT TERM
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(
  cd "$ROOT/vision"
  exec uv run uvicorn app.main:app --host 0.0.0.0 --port "$API_PORT" --reload
) &
API_PID=$!

(
  cd "$ROOT/web"
  exec npm run dev -- --port "$WEB_PORT"
) &
WEB_PID=$!

sleep 2
cat <<EOF

  draw-a-level
  ------------
  web   : http://localhost:${WEB_PORT}   (phone: http://${LAN_IP}:${WEB_PORT})   v2 app; v1 at /v1.html
  api   : http://localhost:${API_PORT}   (health: http://localhost:${API_PORT}/api/v2/health)
  llm   : ${ANTHROPIC_API_KEY:+live (key loaded)}${ANTHROPIC_API_KEY:+}$( [[ -z "${ANTHROPIC_API_KEY:-}" ]] && echo "fake (ANTHROPIC_API_KEY unset)" )

  Ctrl-C stops both.

EOF

wait
