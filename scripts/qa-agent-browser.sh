#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${OPENSESSIONVIEWER_QA_PORT:-3470}"
DB_PATH="${OPENSESSIONVIEWER_QA_DB_PATH:-${SESSION_VIEWER_DB_PATH:-$HOME/.local/share/opencode/opencode.db}}"
SAMPLE_SESSION_ID="${OPENSESSIONVIEWER_QA_SESSION_ID:-ses_1ddf03616ffeTE5c6cbpUPMY3n}"
SESSION_NAME="${OPENSESSIONVIEWER_QA_BROWSER_SESSION:-opensessionviewer-qa-$PORT-$$}"
BASE="${OPENSESSIONVIEWER_QA_BASE_URL:-http://127.0.0.1:$PORT}"

mkdir -p "$ROOT/tmp" "$ROOT/logs"
export npm_config_cache="$ROOT/tmp/npm-cache"
NPX_CMD="${OPENSESSIONVIEWER_QA_NPX:-npx}"

cleanup() {
  "$NPX_CMD" --yes agent-browser --session "$SESSION_NAME" close --all >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_server() {
  local url="$BASE/api/opencode/stats"
  for _ in $(seq 1 40); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Server did not become ready at $url" >&2
  return 1
}

ab() {
  local label="$1"
  shift
  echo "[qa] agent-browser: $label" >&2
  "$NPX_CMD" --yes agent-browser --session "$SESSION_NAME" "$@"
}

read_ab() {
  local label="$1"
  shift
  local slug
  slug="$(printf '%s' "$label" | tr -cs 'A-Za-z0-9_-' '-' | tr 'A-Z' 'a-z')"
  local out="$ROOT/tmp/qa-agent-browser-$slug.out.txt"
  echo "[qa] agent-browser: $label" >&2
  "$NPX_CMD" --yes agent-browser --session "$SESSION_NAME" "$@" > "$out"
  cat "$out"
}

assert_contains() {
  local label="$1"
  local text="$2"
  local pattern="$3"
  if [[ "$text" != *"$pattern"* ]]; then
    echo "$label did not include $pattern" >&2
    return 1
  fi
}

wait_for_server

ab "clear previous session" close --all >/dev/null || true

ab "open dashboard" open "$BASE/opencode" >/dev/null
ab "wait for dashboard" wait --text "Recent Sessions" >/dev/null
dashboard="$(read_ab "read dashboard" get text body)"
assert_contains "dashboard" "$dashboard" "Recent Sessions"

ab "open stats" open "$BASE/opencode/stats" >/dev/null
ab "wait for stats" wait --text "Statistics Overview" >/dev/null

ab "open search" open "$BASE/opencode/search?q=assistant" >/dev/null
ab "wait for search" wait --text "Search" >/dev/null

ab "open session detail" open "$BASE/opencode/session/$SAMPLE_SESSION_ID" >/dev/null
ab "wait for context" wait --text "Context" >/dev/null
detail="$(read_ab "read session detail" get text body)"
assert_contains "detail" "$detail" "Context"
assert_contains "detail" "$detail" "TOOL"

ab "open CodeAgent route" open "$BASE/codeagent" >/dev/null
ab "wait for CodeAgent unavailable state" wait --text "Not installed" >/dev/null

browser_errors="$(read_ab "collect browser errors" errors)"
ab "close session" close >/dev/null

node -e "console.log(JSON.stringify({ ok: true, base: process.argv[1], dbPath: process.argv[2], sampleSessionId: process.argv[3], browserErrors: process.argv[4] }, null, 2))" \
  "$BASE" "$DB_PATH" "$SAMPLE_SESSION_ID" "$browser_errors"
