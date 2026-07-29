#!/usr/bin/env bash
# write-handoff.sh — Generate a dashboard tuning handoff template.
#
# The orchestrator fills in results before ending a session.
# The next session reads this to pick up where the previous left off.
#
# Usage: bash .agents/skills/instruction-dashboard-tuning/scripts/write-handoff.sh
cat << 'TEMPLATE'
# Dashboard Tuning Handoff

## Current Iteration: [N]

## Wireframe
- Target: [URL]
- Desktop: /tmp/dashboard-tuning/wireframe-desktop.png
- Mobile: /tmp/dashboard-tuning/wireframe-mobile.png

## Phase 1: Discovery
| Metric | Value |
|--------|-------|
| Worktree path | [path] |
| Tool calls | |
| Transports found | |
| Routes built | |
| Elimination table | [complete/partial] |

## Phase 2: Build
| Metric | Value |
|--------|-------|
| Tool calls | |
| Components built | |
| Screenshots taken | |
| States covered | |
| Dashboard path | /[route] |

## Phase 3: Review
| Metric | Value |
|--------|-------|
| Reviewer score | /24 |
| Section A findings | [count] |
| Section B findings | [count] |
| GENERALIZED=yes | [count] |

## Findings Applied
- [commit hash] [summary]

## Findings Deferred
- [description] — [reason]

## What's Next
- [ ] [item]

## How to Launch
```bash
bash .agents/hooks/cleanup-agents.sh
bash .agents/skills/instruction-dashboard-tuning/scripts/run-iteration.sh [N+1] [URL]
```
TEMPLATE
