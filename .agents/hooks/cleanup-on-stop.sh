#!/usr/bin/env bash
# SubagentStop hook — kill processes spawned by this agent.
#
# Reads /tmp/interceptor-agent-pids.txt for tracked PIDs.
# Kills only PIDs registered by the stopping agent.
# Follows Anthropic's SubagentTracker pattern.
set -euo pipefail

PID_FILE="/tmp/interceptor-agent-pids.txt"

if [[ ! -f "$PID_FILE" ]]; then
  exit 0
fi

# Kill all tracked PIDs (SIGTERM first, then SIGKILL)
while IFS='|' read -r pid port purpose; do
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
done < "$PID_FILE"

sleep 2

# Force kill survivors
while IFS='|' read -r pid port purpose; do
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
done < "$PID_FILE"

# Clear the registry
rm -f "$PID_FILE"
