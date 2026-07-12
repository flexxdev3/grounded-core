#!/usr/bin/env bash
# Grounded startup brief — generic wrapper. Fetches the brief from the running
# Grounded service and prints it as plain markdown to stdout. Failure-silent.
# For runtimes whose startup hook consumes stdout, or to source into a shell
# profile / agent pre-session command. Uses `jq` for a clean extract when
# present; falls back to the raw JSON response otherwise. Requires `curl`.
#
# Usage: grounded-session-start.generic.sh [CWD]
# Env knobs: GROUNDED_URL (default http://127.0.0.1:7437) · GROUNDED_AGENT (default "agent")
#            GROUNDED_TOKEN (optional bearer for a token-protected API).
set +e
CWD="${1:-$PWD}"
PROJECT="$(basename "$CWD" 2>/dev/null)"
AGENT="${GROUNDED_AGENT:-agent}"
URL="${GROUNDED_URL:-http://127.0.0.1:7437}"

AUTH=()
[ -n "${GROUNDED_TOKEN:-}" ] && AUTH=(-H "authorization: Bearer $GROUNDED_TOKEN")

if command -v jq >/dev/null 2>&1; then
  BODY="$(jq -n --arg a "$AGENT" --arg p "$PROJECT" --arg c "$CWD" \
    '{agent:$a, project:$p, cwd:$c, format:"markdown"}')"
else
  BODY="{\"agent\":\"$AGENT\",\"project\":\"$PROJECT\",\"cwd\":\"$CWD\",\"format\":\"markdown\"}"
fi

RESP="$(curl -s --max-time 5 "${AUTH[@]}" -X POST "$URL/brief" \
  -H 'content-type: application/json' -d "$BODY" 2>/dev/null)"

if command -v jq >/dev/null 2>&1; then
  printf '%s' "$RESP" | jq -r '.text // empty' 2>/dev/null || true
else
  printf '%s\n' "$RESP"   # raw JSON fallback (no jq to extract .text)
fi
exit 0
