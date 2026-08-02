#!/usr/bin/env bash
# run-iteration.sh — Run one full instruction tuning iteration.
#
# Each step runs in a FRESH claude session via -p (print mode).
# Fresh sessions have no stale system-reminder context, so subagents
# read .claude/ files from disk without inheriting deleted file names.
#
# Usage: bash .agents/skills/instruction-tuning/scripts/run-iteration.sh [iteration_number]
set -euo pipefail

ITER="${1:-1}"
HANDOFF=".claude/tuning-handoff.md"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$PROJECT_DIR"

echo "=== Iteration $ITER ==="

# 1. Clean
echo "[Step 1] Cleanup..."
bash .agents/hooks/cleanup-agents.sh

# 2. Launch agents in a fresh session
echo "[Step 2] Launching agents..."
claude -p "
You are running instruction tuning iteration $ITER.
Read .claude/tuning-handoff.md if it exists for prior context.
Read .agents/skills/instruction-tuning/SKILL.md for the process.

Launch discovery agents per the skill's Parallel Testing section.
Use target sites from .claude/tuning-handoff.md (or choose appropriate test targets).
Assign ports starting at 3011, one per agent.

Wait for ALL agents to complete.
Score each against the scorecard in the SKILL.md.
Write results to .claude/tuning-handoff.md.
Do NOT fix instructions — just report results.
" --allowedTools '*' 2>&1 | tee "/tmp/iteration-${ITER}-launch.log"

# 3. Clean between phases
echo "[Step 3] Mid-iteration cleanup..."
bash .agents/hooks/cleanup-agents.sh

# 4. Analyze and fix in a fresh session
echo "[Step 4] Analyzing results and fixing instructions..."
claude -p "
Read .claude/tuning-handoff.md for iteration $ITER results.
Analyze what agents got wrong. Look at:
- Did they fill all 8 elimination rows?
- Did they build routes for every transport found?
- Where did they waste tool calls?
- What patterns are missing from test-server/boardshop?

Fix the instructions in .agents/rules/ and .agents/agents/.
Add any new patterns to test-server and boardshop.
Commit all changes. Push to origin.
Update .claude/tuning-handoff.md for iteration $((ITER + 1)).
" --allowedTools '*' 2>&1 | tee "/tmp/iteration-${ITER}-analyze.log"

echo ""
echo "=== Iteration $ITER complete ==="
echo "Results: .claude/tuning-handoff.md"
echo "Logs: /tmp/iteration-${ITER}-{launch,analyze}.log"
echo ""
echo "To run next iteration:"
echo "  bash .agents/skills/instruction-tuning/scripts/run-iteration.sh $((ITER + 1))"
