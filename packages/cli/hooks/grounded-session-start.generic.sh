#!/usr/bin/env bash
# Grounded startup brief — generic wrapper. Prints the brief as plain markdown
# to stdout (no jq). Failure-silent. For runtimes whose startup hook consumes
# stdout, or to source into a shell profile / agent pre-session command.
#
# Usage: grounded-session-start.generic.sh [CWD]
# Env knobs: GROUNDED_BIN (default "ground") · GROUNDED_AGENT (default "agent").
set +e
CWD="${1:-$PWD}"
PROJECT="$(basename "$CWD" 2>/dev/null)"
"${GROUNDED_BIN:-ground}" brief --format md \
  --agent "${GROUNDED_AGENT:-agent}" --project "$PROJECT" --cwd "$CWD" 2>/dev/null || true
exit 0
