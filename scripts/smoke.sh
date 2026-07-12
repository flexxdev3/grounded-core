#!/usr/bin/env bash
# Grounded end-to-end smoke test. Builds the workspace, stands up the API against
# a throwaway SQLite cabinet, and drives the full loop the way the product now
# works: data flows over the HTTP API (facts/sessions/docs/recall/brief), while
# the `grounded` bin covers cabinet init and agent wiring (mcp/hooks).
#
#   pnpm smoke                 # or: bash scripts/smoke.sh
#
# The embeddings=none leg is the always-green baseline (lexical recall). No local
# data CLI is exercised — that surface was retired in favor of service + API/MCP.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GROUND="node $ROOT/packages/cli/dist/bin.js"
MCP="node $ROOT/packages/mcp/dist/bin.js"
API="node $ROOT/packages/api/dist/bin.js"
PORT=7456
BASE="http://127.0.0.1:$PORT"

TMP="$(mktemp -d)"
export GROUNDED_HOME="$TMP/.grounded"
export GROUNDED_EMBED_PROVIDER="none"
API_PID=""
trap '[ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }
post() { curl -s -X POST "$BASE/$1" -H 'content-type: application/json' -d "$2"; }

echo "==> build"
( cd "$ROOT" && pnpm -r build ) || fail "build"

echo "==> init (sqlite cabinet at $GROUNDED_HOME)"
$GROUND init || fail "init"

echo "==> start api (grounded-api self-bootstraps the cabinet)"
GROUNDED_API_PORT=$PORT $API >/dev/null 2>&1 &
API_PID=$!
curl -s --retry 20 --retry-connrefused --retry-delay 0 -o /dev/null "$BASE/health" \
  || fail "api did not come up"

echo "==> seed facts / session / docs over the API"
post facts   '{"fact":"Never push without explicit instruction","pinned":true}' | grep -q '"id"' || fail "POST /facts"
post sessions '{"summary":"Initialized the demo workspace","project":"demo","agent":"codex"}' | grep -q '"id"' || fail "POST /sessions"
post docs/ingest "{\"paths\":[\"$ROOT/examples/docs\"]}" | grep -q '.' || fail "POST /docs/ingest"

echo "==> recall (embeddings=none, lexical)"
post recall '{"query":"demo workspace","lexicalOnly":true}' | grep -q 'demo' || fail "POST /recall"

echo "==> brief"
post brief '{"agent":"codex","project":"demo"}' | grep -q '.' || fail "POST /brief"

echo "==> vision: set global + project, brief carries the VISION section"
post vision '{"content":"Ship taste at scale. Design out front, engineering underneath."}' | grep -q '"scope":"global"' || fail "POST /vision (global)"
post vision '{"scope":"project:demo","content":"The demo project proves the loop end to end."}' | grep -q '"scope":"project:demo"' || fail "POST /vision (project)"
# second set on the same scope must supersede, leaving exactly one active global record
post vision '{"content":"Ship taste at scale — v2."}' >/dev/null || fail "POST /vision (supersede)"
ACTIVE_COUNT="$(curl -s "$BASE/vision?scope=global" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).length)')"
[ "$ACTIVE_COUNT" = "1" ] || fail "vision supersede left $ACTIVE_COUNT active global records"
BRIEF_TEXT="$(post brief '{"agent":"codex","project":"demo"}')"
case "$BRIEF_TEXT" in *'=== VISION (global · project:demo) ==='*) echo "   vision section OK" ;; *) fail "brief missing VISION section" ;; esac
case "$BRIEF_TEXT" in *'Apply this:'*) echo "   apply line OK" ;; *) fail "brief missing apply line" ;; esac
case "$BRIEF_TEXT" in *'v2'*) echo "   supersede OK (brief shows the new version)" ;; *) fail "brief shows stale vision" ;; esac

echo "==> console + health served on one origin"
case "$(curl -s "$BASE/")" in *'id="app"'*) echo "   console OK" ;; *) fail "console not served at /" ;; esac
case "$(curl -s "$BASE/health")" in *'"ok":true'*) echo "   health OK" ;; *) fail "health not served" ;; esac

kill "$API_PID" 2>/dev/null; API_PID=""

echo "==> mcp install snippet is valid JSON"
$GROUND --json mcp install claude-code \
  | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8")); console.log("   snippet OK")' \
  || fail "mcp install snippet invalid"

echo "==> hooks print claude-code is non-empty"
case "$($GROUND hooks print claude-code)" in *SessionStart*) echo "   hooks OK" ;; *) fail "hooks print" ;; esac

echo "==> grounded-mcp tools/list over stdio"
MCP_OUT="$(printf '%s\n%s\n' \
 '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
 '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
 | timeout 15 $MCP 2>/dev/null)"
case "$MCP_OUT" in *ground_recall*) echo "   tools/list OK" ;; *) fail "mcp tools/list" ;; esac

echo "ALL GOOD"
