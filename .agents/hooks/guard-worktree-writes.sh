#!/usr/bin/env bash
# PreToolUse hook — deny writes to main repo from worktrees.
# Worktrees are at /tmp/interceptor-worktrees/ (outside the repo).
set -euo pipefail

INPUT="$(cat)"
CWD="$(printf '%s' "$INPUT" | jq -r '.cwd')"
FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')"

# Only apply in worktrees (external path)
if [[ "$CWD" != "/tmp/interceptor-worktrees/"* ]]; then
  exit 0
fi

# No file path = not a file tool, allow
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# If path is inside the worktree cwd, allow
if [[ "$FILE_PATH" == "$CWD/"* || "$FILE_PATH" == "$CWD" ]]; then
  exit 0
fi

# If path is inside /tmp/interceptor-worktrees/ but a different worktree, allow
# (shouldn't happen but be safe)
if [[ "$FILE_PATH" == "/tmp/interceptor-worktrees/"* ]]; then
  exit 0
fi

# Everything else is outside the worktree — DENY
jq -n --arg cwd "$CWD" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("WRONG PATH. You are in a worktree. Use paths starting with: " + $cwd + "/")
  }
}'
