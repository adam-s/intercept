---
name: visual-dev
description: Visual development with Patchright screenshots. Use when building, fixing, reviewing, or creating new UI pages and dashboard components. Use when the user wants to build a dashboard, create a new page, verify UI works correctly, or iterate on visual design. Takes screenshots, analyzes layout, iterates until correct.
---

# Visual Development Loop

**This skill is a mandatory validation gate, not an optional polish step.** Every dashboard page must be screenshotted and judged against the 7 criteria before the iteration is complete. See `dashboard-builder/SKILL.md` "Required states" table for the full list of visual states to implement and screenshot.

**Core principle:** Build, screenshot, judge, fix, re-screenshot, repeat until zero problems. The screenshot loop IS the development loop.

**Prompt compliance gate:** Before committing: list every prompt requirement, state evidence for each (curl output, screenshot, Patchright click). Any requirement without evidence = not done. Loop until all have evidence.

## Prerequisites

### 1. Discover the running server

```bash
lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | grep -E ':(3000|3001|3002|3003|4000|5173|8080)\s'
```

**CRITICAL**: `curl` every candidate port and verify the HTML title matches this project before setting `BASE_URL`.

### 2. Discover auth credentials

Search for login files, then check: existing e2e tests, seed files, `.env.test`, CLAUDE.md. Also extract the post-login redirect URL for `waitForURL`.

### 3. Create screenshot directory

```bash
mkdir -p /tmp/interceptor-dev-screenshots
```

## Phase Overview

| Phase | Purpose | Details |
|-------|---------|---------|
| **1. Understand** | Read source code, build mental model before screenshotting | [reference/phase-1-understand.md](reference/phase-1-understand.md) |
| **2. Enumerate** | List every visual state before taking any screenshots | [reference/phase-2-enumerate.md](reference/phase-2-enumerate.md) |
| **3. Verify** | Build + screenshot + judge loop with 7 criteria | [reference/phase-3-verify.md](reference/phase-3-verify.md) |
| **4. Interactions** | Test button clicks, form submits, state transitions | [reference/phase-4-interactions.md](reference/phase-4-interactions.md) |
| **5. Viewports** | Multi-viewport sweep (mobile, tablet, desktop, wide) | [reference/phase-5-viewports.md](reference/phase-5-viewports.md) |

**Cross-cutting references:**
- [reference/ui-patterns.md](reference/ui-patterns.md) — shadcn components, transitions, dark mode
- [reference/common-visual-bugs.md](reference/common-visual-bugs.md) — Common bugs checklist
- [reference/troubleshooting.md](reference/troubleshooting.md) — Getting unstuck

## Critical Gate

The loop for a given state ends when you find **zero issues** across all 7 judgment criteria (3-second test, data accuracy, visual hierarchy, interaction affordance, error communication, empty states, density balance). The full page is done when every enumerated state passes.

## Cleanup

Run only at the very end, after all states pass. Delete the entire directory:

```bash
rm -rf /tmp/interceptor-dev-screenshots/
```

Do this before committing or switching branches. Never leave Patchright scripts in the repo.
