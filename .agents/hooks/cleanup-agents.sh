#!/usr/bin/env bash
# cleanup-agents.sh — Nuclear cleanup of all agent processes and artifacts.
#
# Run BEFORE every iteration to ensure clean state.
# Follows Anthropic's eval engine pattern: always cleanup, even on error.
#
# Usage: bash .agents/hooks/cleanup-agents.sh
set -euo pipefail

echo "=== Agent Cleanup ==="

# 1. Kill tracked PIDs from registry (if any)
PID_FILE="/tmp/interceptor-agent-pids.txt"
if [[ -f "$PID_FILE" ]]; then
  echo "Killing tracked PIDs..."
  while IFS='|' read -r pid port purpose; do
    kill -TERM "$pid" 2>/dev/null && echo "  TERM $pid ($purpose)" || true
  done < "$PID_FILE"
  sleep 2
  while IFS='|' read -r pid port purpose; do
    kill -9 "$pid" 2>/dev/null && echo "  KILL $pid ($purpose)" || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# 2. Kill agent API servers by port range (3011-3021, 3031-3049)
echo "Clearing agent ports..."
for port in $(seq 3011 3021) $(seq 3031 3049); do
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
    echo "  Port $port: killed"
  fi
done

# 3. Kill agent-related processes (NOT user's Chrome)
echo "Killing agent processes..."
pkill -9 -f "tsx.*src/index" 2>/dev/null || true
pkill -9 -f "connect-browser" 2>/dev/null || true
pkill -9 -f "patchright" 2>/dev/null || true
# NEVER: pkill chrome, pkill chromium

sleep 2

# 4. Clean up tmp files from previous iterations
echo "Cleaning tmp files..."
rm -f /tmp/api-server-*.log 2>/dev/null || true
rm -f /tmp/interceptor-debug/*.log 2>/dev/null || true
rm -rf /tmp/dashboard-tuning/ 2>/dev/null || true

# 5. Remove ALL worktrees (external + internal)
echo "Removing worktrees..."
rm -rf /tmp/interceptor-worktrees/ 2>/dev/null || true
if [[ -d ".claude/worktrees" ]]; then
  rm -rf .claude/worktrees/ 2>/dev/null || true
fi
git worktree prune 2>/dev/null || true

# 6. Remove untracked domains
echo "Cleaning domains..."
ls domains/ 2>/dev/null | while read -r d; do
  if ! git ls-files --error-unmatch "domains/$d" > /dev/null 2>&1; then
    echo "  Removing: domains/$d"
    rm -rf "domains/$d"
  fi
done

# 7. Revert contaminated shared files
echo "Reverting shared files..."
git checkout HEAD -- apps/api/src/register-domains.ts apps/api/package.json pnpm-lock.yaml .gitignore 2>/dev/null || true

# 8. Remove stale symlinks from old worktree pnpm
for link in packages/shared/shared packages/browser/browser; do
  [[ -L "$link" ]] && rm -f "$link" && echo "  Removed symlink: $link"
done

# 9. Verify
echo ""
echo "=== Verification ==="
echo "Domains: $(ls domains/ | tr '\n' ' ')"
echo "Modified: $(git diff --name-only 2>/dev/null | grep -v browser.log | tr '\n' ' ')"

NODE_COUNT=$(pgrep -f "tsx\|node.*src/index" 2>/dev/null | wc -l | tr -d ' ')
echo "Agent processes: $NODE_COUNT"

WORKTREE_COUNT=$(git worktree list 2>/dev/null | wc -l | tr -d ' ')
echo "Worktrees: $WORKTREE_COUNT (should be 1)"

if [[ "$NODE_COUNT" -eq 0 && "$WORKTREE_COUNT" -eq 1 ]]; then
  echo ""
  echo "=== CLEAN ==="
else
  echo ""
  echo "=== WARNING: Not fully clean ==="
fi
