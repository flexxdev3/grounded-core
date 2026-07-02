#!/usr/bin/env bash
# Grounded end-to-end smoke test. Builds the workspace, then runs the full loop
# against a throwaway SQLite cabinet using the built bins directly from dist/.
#
#   pnpm smoke                 # or: bash scripts/smoke.sh
#
# The embeddings=none leg is the always-green baseline. The Ollama leg is wrapped
# non-fatal so this passes on a machine without the homelab GPU box reachable.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GROUND="node $ROOT/packages/cli/dist/bin.js"
MCP="node $ROOT/packages/mcp/dist/bin.js"
API="node $ROOT/packages/api/dist/bin.js"

# Throwaway cabinet for this run.
TMP="$(mktemp -d)"
export GROUNDED_HOME="$TMP/.grounded"
export GROUNDED_EMBED_PROVIDER="none"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

echo "==> build"
( cd "$ROOT" && pnpm -r build ) || fail "build"

echo "==> init (sqlite cabinet at $GROUNDED_HOME)"
$GROUND init || fail "init"

echo "==> seed facts / session / docs"
$GROUND facts add "Never push without explicit instruction" --pin || fail "facts add"
$GROUND session add --project demo --agent codex "Initialized the demo workspace" || fail "session add"
$GROUND docs ingest "$ROOT/examples/docs" || fail "docs ingest"

echo "==> recall (embeddings=none, lexical)"
$GROUND recall "demo workspace" --lexical-only || fail "recall (none)"

echo "==> recall (ollama @ homelab, non-fatal)"
GROUNDED_EMBED_PROVIDER=ollama \
GROUNDED_EMBED_BASEURL="${GROUNDED_EMBED_BASEURL:-http://192.168.1.217:11434}" \
GROUNDED_EMBED_MODEL="${GROUNDED_EMBED_MODEL:-nomic-embed-text}" \
  $GROUND recall "what did we decide about memory" \
  && echo "   (ollama recall OK)" \
  || echo "   (ollama recall skipped/failed — non-fatal)"

echo "==> brief"
$GROUND brief --agent codex --project demo --cwd "$ROOT" || fail "brief"

echo "==> mcp install snippet is valid JSON"
$GROUND --json mcp install claude-code \
  | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8")); console.log("   snippet OK")' \
  || fail "mcp install snippet invalid"

echo "==> hooks print claude-code is non-empty"
HOOKS_OUT="$($GROUND hooks print claude-code)"
case "$HOOKS_OUT" in *SessionStart*) echo "   hooks OK" ;; *) fail "hooks print" ;; esac

echo "==> api serves the console + JSON on one origin"
API_PORT=7456
GROUNDED_API_PORT=$API_PORT $API >/dev/null 2>&1 &
API_PID=$!
curl -s --retry 20 --retry-connrefused --retry-delay 0 -o /dev/null "http://127.0.0.1:$API_PORT/health" \
  || { kill $API_PID 2>/dev/null; fail "api did not come up"; }
INDEX_OUT="$(curl -s "http://127.0.0.1:$API_PORT/")"
HEALTH_OUT="$(curl -s "http://127.0.0.1:$API_PORT/health")"
kill $API_PID 2>/dev/null
case "$INDEX_OUT" in *'id="app"'*) echo "   console OK" ;; *) fail "console not served at /" ;; esac
case "$HEALTH_OUT" in *'"ok":true'*) echo "   health OK" ;; *) fail "health not served" ;; esac

echo "==> grounded-mcp tools/list over stdio"
MCP_OUT="$(printf '%s\n%s\n' \
 '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
 '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
 | timeout 15 $MCP 2>/dev/null)"
case "$MCP_OUT" in *ground_recall*) echo "   tools/list OK" ;; *) fail "mcp tools/list" ;; esac

echo "ALL GOOD"
