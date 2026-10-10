#!/usr/bin/env bash
# Writes the printable blank sheet to ./out/blank.pdf (PLAN.md section 5).
# Usage: scripts/print_templates.sh [out_dir] [game_id]
# Calls the template CLI in vision/app/template/generate.py, which lane A implements in phase 2.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/out}"
GAME_ID="${2:-}"
mkdir -p "$OUT"

cd "$ROOT/vision"
if [[ -n "$GAME_ID" ]]; then
  uv run python -m app.template.generate blank --out "$OUT/blank_${GAME_ID}.pdf" --game-id "$GAME_ID"
else
  uv run python -m app.template.generate blank --out "$OUT/blank.pdf"
fi
echo "Print at any scale; only the layout matters, not the size."
