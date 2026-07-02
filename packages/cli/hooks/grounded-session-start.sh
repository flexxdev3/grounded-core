#!/usr/bin/env bash
# Grounded SessionStart hook (Claude Code / Gemini).
# Injects the Grounded startup brief as additionalContext. Failure-silent:
# it never blocks agent startup. Requires `jq` and the `ground` CLI on PATH.
#
# Wire it (Claude Code ~/.claude/settings.json):
#   "hooks": { "SessionStart": [ { "hooks": [
#     { "type": "command", "command": "/abs/path/to/grounded-session-start.sh" } ] } ] }
#
# Env knobs: GROUNDED_BIN (default "ground") · GROUNDED_AGENT (default "claude").
set +e

PAYLOAD=""
[ ! -t 0 ] && PAYLOAD="$(cat 2>/dev/null || true)"

CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // .projectDir // .workspaceDir // empty' 2>/dev/null)"
[ -z "$CWD" ] && CWD="${CLAUDE_PROJECT_DIR:-$PWD}"
PROJECT="$(basename "$CWD" 2>/dev/null)"
AGENT="${GROUNDED_AGENT:-claude}"
GROUND="${GROUNDED_BIN:-ground}"

BRIEF="$("$GROUND" brief --format md --agent "$AGENT" --project "$PROJECT" --cwd "$CWD" 2>/dev/null)"
if [ $? -ne 0 ] || [ -z "$BRIEF" ]; then
  jq -n '{}' 2>/dev/null || printf '{}\n'   # silent no-op; agent starts normally
  exit 0
fi

jq -n --arg ctx "$BRIEF" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}' \
  2>/dev/null || printf '{}\n'
exit 0
