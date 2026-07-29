#!/usr/bin/env bash
# run-iteration.sh — Run one full dashboard tuning iteration.
#
# Three phases, each in a FRESH claude session via -p (print mode).
# Fresh sessions have no stale system-reminder context.
#
# Usage: bash .agents/skills/instruction-dashboard-tuning/scripts/run-iteration.sh <iteration> <target_url>
set -euo pipefail

ITER="${1:?Usage: run-iteration.sh <iteration_number> <target_url>}"
TARGET="${2:?Usage: run-iteration.sh <iteration_number> <target_url>}"
HANDOFF=".claude/dashboard-tuning-handoff.md"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_PORT=3031
WEB_PORT=3041

cd "$PROJECT_DIR"

echo "=== Dashboard Tuning Iteration $ITER ==="
echo "Target: $TARGET"
echo "API Port: $API_PORT, Web Port: $WEB_PORT"

# 1. Clean
echo "[Step 1] Cleanup..."
bash .agents/hooks/cleanup-agents.sh
for port in $(seq 3031 3049); do
  lsof -ti:"$port" | xargs kill -9 2>/dev/null || true
done
rm -rf /tmp/dashboard-tuning/
mkdir -p /tmp/dashboard-tuning/screenshots

# 2. Phase 1: Discovery
echo "[Step 2] Phase 1 — Discovery..."
claude -p "
You are running dashboard tuning iteration $ITER, Phase 1 (Discovery).
Read .claude/dashboard-tuning-handoff.md if it exists for prior context.
Read .agents/skills/instruction-dashboard-tuning/SKILL.md for the process.

First, capture wireframe screenshots of $TARGET:
- Desktop (1280x800) → /tmp/dashboard-tuning/wireframe-desktop.png
- Mobile (375x800) → /tmp/dashboard-tuning/wireframe-mobile.png

Then launch a discovery agent in a worktree. Port: $API_PORT.
Target: $TARGET
Wait for completion. Score against the discovery scorecard.
Write Phase 1 results to .claude/dashboard-tuning-handoff.md.
Record the worktree path — Phase 2 needs it.
" --allowedTools '*' 2>&1 | tee "/tmp/dashboard-tuning/phase1-iter${ITER}.log"

# 3. Clean between phases (keep worktree)
echo "[Step 3] Mid-iteration cleanup (preserving worktree)..."
pkill -9 -f "tsx.*src/index" 2>/dev/null || true
pkill -9 -f "connect-browser" 2>/dev/null || true
for port in $API_PORT $WEB_PORT; do
  lsof -ti:"$port" | xargs kill -9 2>/dev/null || true
done
sleep 2

# 4. Phase 2: Build
echo "[Step 4] Phase 2 — Build..."
claude -p "
You are running dashboard tuning iteration $ITER, Phase 2 (Build).
Read .claude/dashboard-tuning-handoff.md for the worktree path and discovery results.

Launch a builder agent in the SAME worktree from Phase 1.
API port: $API_PORT. Web port: $WEB_PORT.
Wireframe: /tmp/dashboard-tuning/wireframe-desktop.png

Wait for completion. Then capture dashboard screenshots at 4 viewports:
  node scripts/snapshot.mjs --path=/PAGE --port=$WEB_PORT --label=iter-$ITER
  # One PNG per viewport (mobile/tablet/desktop) in .snapshots/iter-$ITER/, plus summary.json

Score against the builder scorecard. Update handoff.
" --allowedTools '*' 2>&1 | tee "/tmp/dashboard-tuning/phase2-iter${ITER}.log"

# 5. Phase 3: Review + Apply
echo "[Step 5] Phase 3 — Review + Apply..."
claude -p "
You are running dashboard tuning iteration $ITER, Phase 3 (Review + Apply).
Read .claude/dashboard-tuning-handoff.md for the worktree path and build results.

Launch a reviewer agent that reads:
  - Worktree: [path from handoff]
  - Screenshots: /tmp/dashboard-tuning/screenshots/
  - Wireframe: /tmp/dashboard-tuning/wireframe-desktop.png

Wait for the reviewer's findings report.
Apply GENERALIZED=yes instruction improvements to .claude/.
Apply framework code fixes to packages/, apps/, services/, scripts/, tests/.
Run consistency check: grep .claude/ for concepts you changed.
Commit all changes.
Update handoff for iteration $((ITER + 1)).
" --allowedTools '*' 2>&1 | tee "/tmp/dashboard-tuning/phase3-iter${ITER}.log"

# 6. Final cleanup
echo "[Step 6] Final cleanup..."
bash .agents/hooks/cleanup-agents.sh

echo ""
echo "=== Iteration $ITER complete ==="
echo "Results: .claude/dashboard-tuning-handoff.md"
echo "Logs: /tmp/dashboard-tuning/phase{1,2,3}-iter${ITER}.log"
echo ""
echo "To run next iteration:"
echo "  bash .agents/skills/instruction-dashboard-tuning/scripts/run-iteration.sh $((ITER + 1)) <target_url>"
