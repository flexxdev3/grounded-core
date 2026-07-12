#!/usr/bin/env bash
# Grounded SessionStart hook (Claude Code / Gemini).
# Fetches the startup brief from the running Grounded service and injects it as
# additionalContext. Failure-silent: it never blocks agent startup. Requires
# `jq` and `curl`, and a Grounded service reachable at $GROUNDED_URL.
#
# Wire it (Claude Code ~/.claude/settings.json):
#   "hooks": { "SessionStart": [ { "hooks": [
#     { "type": "command", "command": "/abs/path/to/grounded-session-start.sh" } ] } ] }
#
# Env knobs: GROUNDED_URL (default http://127.0.0.1:7437) · GROUNDED_AGENT (default "claude")
#            GROUNDED_TOKEN (optional bearer for a token-protected API).
set +e

PAYLOAD=""
[ ! -t 0 ] && PAYLOAD="$(cat 2>/dev/null || true)"

CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // .projectDir // .workspaceDir // empty' 2>/dev/null)"
[ -z "$CWD" ] && CWD="${CLAUDE_PROJECT_DIR:-$PWD}"
PROJECT="$(basename "$CWD" 2>/dev/null)"
AGENT="${GROUNDED_AGENT:-claude}"
URL="${GROUNDED_URL:-http://127.0.0.1:7437}"

AUTH=()
[ -n "${GROUNDED_TOKEN:-}" ] && AUTH=(-H "authorization: Bearer $GROUNDED_TOKEN")

BODY="$(jq -n --arg a "$AGENT" --arg p "$PROJECT" --arg c "$CWD" \
  '{agent:$a, project:$p, cwd:$c, format:"markdown"}' 2>/dev/null)"

BRIEF="$(curl -s --max-time 5 "${AUTH[@]}" -X POST "$URL/brief" \
  -H 'content-type: application/json' -d "$BODY" 2>/dev/null | jq -r '.text // empty' 2>/dev/null)"

if [ -z "$BRIEF" ]; then
  jq -n '{}' 2>/dev/null || printf '{}\n'   # silent no-op; agent starts normally
  exit 0
fi

jq -n --arg ctx "$BRIEF" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}' \
  2>/dev/null || printf '{}\n'
exit 0
