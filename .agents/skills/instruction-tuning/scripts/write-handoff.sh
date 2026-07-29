#!/usr/bin/env bash
# write-handoff.sh — Generate a handoff template.
#
# The orchestrator fills in results before ending a session.
# The next session reads this to pick up where the previous left off.
#
# Usage: bash .agents/skills/instruction-tuning/scripts/write-handoff.sh
cat << 'TEMPLATE'
# Instruction Tuning Handoff

## Current Iteration: [N]

## Results

| Agent | Tokens | Time | Routes | Elimination (8/8?) | Notes |
|-------|--------|------|--------|--------------------|-|
| [fill per agent] | | | | | |

## Algorithm
GATHER→SCAN→CLASSIFY→BUILD pipeline in .agents/rules/discovery.md

## What Changed This Session
- [commit hash] [summary]

## What's Next
- [ ] [item]

## How to Launch
```bash
bash .agents/hooks/cleanup-agents.sh
# Launch agents per .agents/skills/instruction-tuning/SKILL.md
```
TEMPLATE
