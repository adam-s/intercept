---
description: Autonomous iteration mode — the build loop, verification gates, server startup, and branch management
paths:
  - "domains/**"
  - "prompts/**"
  - "apps/web/src/app/(dashboard)/**"
---

# Autonomous Iteration Mode

Full autonomous operation granted. You may commit, create branches, and make decisions without asking. Skip `EnterPlanMode` — but do NOT skip self-verification gates.

## The Iteration Loop

```text
FOR each prompt:
  0. READ + OBSERVE
     a. Extract every requirement into a numbered list. This is your contract.
     b. Validate against the test server first (port 4444).
     c. Connect browser via WebSocket. Follow `.agents/rules/discovery.md`.
  1. Build API routes → curl each → paste response proving real data
     Cache fixtures: curl responses → data/fixtures/{domain}/
     FIXTURE_DIR=data/fixtures pnpm dev for instant UI development.
  2. Build UI → screenshot → fix → re-screenshot → repeat
  3. Wire interactions → verify with Patchright
  4. Full QA → screenshot every state → zero issues
  5. Prompt Compliance Matrix (see prompt-compliance rule) → all PASS
  6. Commit only after Step 5 shows ALL PASS
```

## Server Startup

```bash
lsof -ti:3001 | xargs kill -9 2>/dev/null; lsof -ti:3000 | xargs kill -9 2>/dev/null
pnpm --filter api dev > /tmp/api-server.log 2>&1 &
pnpm --filter web dev > /tmp/web-server.log 2>&1 &
sleep 6 && curl -s http://localhost:3001/health
```

## Returning to Main

1. Commit domain work on the test branch
2. `git checkout main` — strip domain artifacts
3. Apply each framework fix to the file that owns it, run CI, commit
4. Delete the old test branch, cut a new one
