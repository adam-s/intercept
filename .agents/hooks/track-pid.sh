#!/usr/bin/env bash
# track-pid.sh — Register a spawned process for cleanup tracking.
#
# Usage: .agents/hooks/track-pid.sh <pid> <port> <purpose>
# Example: .agents/hooks/track-pid.sh $! 3011 "api-server"
#
# Appends to /tmp/interceptor-agent-pids.txt for cleanup-agents.sh to read.
set -euo pipefail

PID="${1:?Usage: track-pid.sh <pid> <port> <purpose>}"
PORT="${2:-0}"
PURPOSE="${3:-unknown}"
PID_FILE="/tmp/interceptor-agent-pids.txt"

echo "${PID}|${PORT}|${PURPOSE}" >> "$PID_FILE"
