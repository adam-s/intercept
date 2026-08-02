#!/usr/bin/env bash
# WorktreeCreate hook — branches from LOCAL HEAD, worktree OUTSIDE repo.
#
# Two fixes over default Claude Code behavior:
# 1. Branches from local HEAD (not origin/HEAD) so unpushed commits are visible
# 2. Creates worktrees OUTSIDE the repo tree (like Anthropic's eval engine does)
#    to avoid pnpm workspace interference and path confusion
set -euo pipefail

INPUT="$(cat)"
NAME="$(printf '%s' "$INPUT" | jq -r '.name')"
CWD="$(printf '%s' "$INPUT" | jq -r '.cwd')"

# Create worktrees OUTSIDE the repo, like Anthropic's eval engine
WORKTREE_DIR="/tmp/interceptor-worktrees/$NAME"
BRANCH_NAME="worktree-$NAME"

# Clean up if directory already exists (stale from previous run)
if [ -d "$WORKTREE_DIR" ]; then
  git -C "$CWD" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
  rm -rf "$WORKTREE_DIR" 2>/dev/null || true
fi

# Create worktree from local HEAD
git -C "$CWD" worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR" HEAD >&2

echo "$WORKTREE_DIR"
