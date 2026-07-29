---
name: instruction-dashboard-tuning
description: Use sub-agents to iteratively improve dashboard-building instructions. Three-phase pipeline — discover APIs, build dashboard matching a wireframe, review code + UI with a SOTA reviewer agent. The dashboards are throwaway; instruction improvements and framework code fixes are the product.
---

> **DO NOT write memory files.** All learnings go into `.agents/skills/`, `.agents/agents/`, `.agents/rules/`, or framework code — NOT into memory.

# Instruction Dashboard Tuning via Sub-Agent Testing

## Consent check — **CRITICAL · MANDATORY**

**Check if `.agents/user-consent.md` exists with `ACCEPTED: true`.** If yes, display: `Prior consent on file (DATE). Proceeding.` and skip to "Before Starting."

If not, present the 3 warnings from `.agents/skills/instruction-tuning/SKILL.md` (ToS, autonomous agents, resource consumption). All 3 must be accepted. Write `.agents/user-consent.md` on acceptance. This file is shared across both tuning skills.

## How This Works

You are not building dashboards. You are writing instructions that make other agents build correct dashboards.

1. **Capture a wireframe** — screenshot a real website (any data-rich site with lists, tables, or dashboards). This is the design target.
2. **Launch a discovery agent** — discovers ALL transports via the already-tuned discovery protocol.
3. **Launch a builder agent** — builds a dashboard matching the wireframe using the discovered API routes.
4. **Launch a reviewer agent** — a SOTA frontier LLM that reviews the code + screenshots and produces structured findings.
5. **Apply findings** — instruction improvements go to `.claude/`, framework code fixes go to `packages/`, `apps/`, etc.
6. **Discard the worktree** — the dashboard is throwaway. The instruction and code improvements are the product.

## Before Starting — Ask the User

**Turn 1:** Ask how many discovery passes — 1 or 2? Default to 1.
- **1 pass:** Full breadth discovery, then build dashboard.
- **2 passes:** Pass 1 = breadth. Pass 2 = deep dive on missed transports. Then build dashboard with the combined routes.

**Turn 2:** Ask which websites to use as wireframes. The user picks the sites.

**Turn 3:** Ask what to do when agents finish. Pick one:
- **A) Full cleanup** (default) — kill processes, delete worktrees, revert shared files.
- **B) Keep worktrees** — kill processes but preserve worktree directories for reuse.
- **C) Keep agents alive** — don't stop running agents, allow continuation or redirection.
- **D) Keep both** — preserve worktrees AND keep agents alive.

Do NOT launch agents until the user answers all questions.

## The Three-Phase Pipeline

```
SCREENSHOT of real website = the "wireframe"
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
 Phase 1     Phase 2     Phase 3
 DISCOVERY   BUILD        REVIEW
 (worktree)  (same wt)   (read-only)
    │           │           │
    ▼           ▼           ▼
 Domain      Dashboard   Findings
 plugin      matching    report
 w/ routes   wireframe     │
                      ┌────┴────┐
                      ▼         ▼
                  .claude/   packages/
                  skills/    apps/ etc.
                      │
                      ▼
               WORKTREE DELETED
               IMPROVEMENTS KEPT
```

## The Loop

```
1.  Clean: bash .agents/hooks/cleanup-agents.sh
    Also: for port in $(seq 3031 3049); do lsof -ti:"$port" | xargs kill -9 2>/dev/null; done
    Also: rm -rf /tmp/dashboard-tuning/
2.  Verify commit: ensure worktrees branch from latest committed instructions
3.  Capture wireframe:
    mkdir -p /tmp/dashboard-tuning
    Screenshot target website at 1280x800 → /tmp/dashboard-tuning/wireframe-desktop.png
    Screenshot at 375x800 → /tmp/dashboard-tuning/wireframe-mobile.png
4.  Launch Phase 1 (Discovery) in worktree (run_in_background: true)
5.  LIVE MONITOR every 60s until discovery completes
6.  Verify: elimination table filled, routes return data via curl
7.  Launch Phase 2 (Build) in SAME worktree (run_in_background: true)
8.  LIVE MONITOR every 60s until build completes
8b. VERIFY PROXY — before screenshots, confirm the web proxy reaches the API:
    curl -s http://localhost:$WEB_PORT/api/$DOMAIN/ROUTE | head -c 200
    If this fails (500, empty), the web server was started without API_PORT=$API_PORT.
    Kill, restart with API_PORT=$API_PORT PORT=$WEB_PORT, re-verify.
8c. VERIFY PLACEMENT — check page is in (dashboard)/ group:
    ls apps/web/src/app/\(dashboard\)/PAGE_NAME/page.tsx
    If the page is at apps/web/src/app/PAGE_NAME/ instead, that's a finding.
9.  Capture dashboard screenshots at 4 viewports (375, 768, 1280, 1920):
    mkdir -p /tmp/dashboard-tuning/screenshots
    node scripts/snapshot.mjs --path=/PAGE --port=$WEB_PORT --label=iter-$ITER
10. Launch Phase 3 (Review) — reviewer reads worktree + screenshots (run_in_background: true)
11. MONITOR until reviewer produces findings report
12. Process findings:
    a. Apply GENERALIZED=yes instruction improvements to .claude/
    b. Apply framework code fixes to packages/, apps/, services/, scripts/, tests/
    c. CONSISTENCY CHECK — grep all .claude/ for the concept you changed
13. PRUNE .claude/ — run `wc -l .agents/skills/dashboard-builder/SKILL.md .agents/agents/dashboard-agent.md`.
    If any file exceeds 300 lines, extract the bottom third to a `reference/` subdirectory.
    Keep the main file focused on: architecture, build steps, states, wireframe fidelity, responsive, errors.
    Niche patterns (comment trees, video, sparklines, CRUD) go in reference files.
14. Process cleanup: kill servers, remove worktree
15. Commit fixes to main
16. Write handoff (.claude/dashboard-tuning-handoff.md, gitignored)
17. Start fresh Claude Code session, repeat
```

## Phase 1: Discovery

Reuses the already-tuned discovery protocol. No new instructions needed.

**Agent:** `discovery-agent` (`.agents/agents/discovery-agent.md`)

**Prompt template:**
```
Discover ALL transport types that [site] uses. Build a route for EVERY transport found.
Target: [url]
Follow .agents/rules/discovery.md — GATHER→SCAN→CLASSIFY→BUILD.
In GATHER: connect to HOMEPAGE first and browse naturally (scroll, click) to warm up cookies before navigating to target pages. Intercept pagination traffic. If you see an API endpoint with pagination params in traffic, test it directly via /browser/mcp/fetch. For cross-origin APIs, credentials are forwarded automatically.
In CLASSIFY: name the site's core data and verify your transports cover it.
In BUILD: auth-gated endpoints (Gap=Y) go directly to session harvest. Read the session harvest reference file BEFORE writing any harvest code.
Fill ALL 8 elimination rows before writing code.
After building routes, register your domain and test EVERY route through the API server proxy.
Before finishing: run `pnpm biome check --write --unsafe .` and fix any remaining lint or type errors. CI must be clean.
Budget: ~150 tool calls. Plan: ~30 GATHER, ~10 SCAN/CLASSIFY, ~80 BUILD, ~30 testing.
Your port is XXXX.
```

**Port:** 3031+N (API only — discovery doesn't need a web server)

## Phase 2: Build

**Agent:** `dashboard-agent` (`.agents/agents/dashboard-agent.md`)

**Prompt template:**
```
Build a dashboard that matches the wireframe screenshot at /tmp/dashboard-tuning/wireframe-desktop.png.

API routes are already working in this worktree:
[paste output of curl -s http://localhost:API_PORT/api]

Read these skill files before starting:
1. .agents/skills/dashboard-builder/SKILL.md — the build process
2. .agents/skills/visual-dev/SKILL.md — screenshot + judge loop
3. .agents/skills/debug-logs/SKILL.md — when data doesn't flow
4. .agents/skills/systematic-testing/SKILL.md — verify API routes first

Your wireframe: Read /tmp/dashboard-tuning/wireframe-desktop.png
This is a real website screenshot. Match its:
- Layout structure (grid, sidebar, header)
- Information density (items per row, spacing)
- Typography hierarchy (title vs metadata sizing)
- Component patterns (cards, badges, thumbnails)

The gap between your dashboard screenshot and the wireframe IS the bug.

Structural requirements:
- Place page in (dashboard)/ group: apps/web/src/app/(dashboard)/<page-name>/page.tsx
- If the wireframe has its own header/footer/nav, add a layout.tsx opt-out:
  export default function Layout({ children }: { children: React.ReactNode }) { return <>{children}</>; }
- Use shadcn/ui Button (not raw <button>), Alert (not raw <div>), for ALL interactive/status elements
- Override visual tokens (className + style), not component choice
- If API returns HTML fragments, sanitize with DOMPurify before dangerouslySetInnerHTML

When starting servers, set ports explicitly:
  PORT=$API_PORT pnpm --filter @interceptor/api dev
  API_PORT=$API_PORT PORT=$WEB_PORT pnpm --filter @interceptor/web dev

Before finishing: run `pnpm biome check --write --unsafe .` and fix any remaining lint or type errors. CI must be clean.
API port: XXXX. Web port: YYYY.
Budget: 80 tool calls.
```

**Ports:** API 3031+N, Web 3041+N

**Before launching:** Kill the discovery agent's API server, then restart with both API and Web servers in the same worktree.

## Phase 3: Review

**Agent:** `reviewer-agent` (`.agents/agents/reviewer-agent.md`)

**Prompt template:**
```
Review the dashboard built by another agent.

Worktree code: [WORKTREE_PATH]
Dashboard screenshots: /tmp/dashboard-tuning/screenshots/
Wireframe: /tmp/dashboard-tuning/wireframe-desktop.png

Read ALL component files in the dashboard directory.
Read ALL screenshots (4 viewports) and the wireframe.
Read the .claude/ instruction files the builder was supposed to follow.

Score on the 12-point review. Compare wireframe to dashboard — name SPECIFIC differences.
Produce Section A (instruction improvements) and Section B (framework code fixes).
Only include GENERALIZED=yes findings.

Budget: 40 tool calls.
```

**Runs from main repo** (not a worktree). Reads the worktree path but writes nothing.

## Live Monitoring

Parse the agent output file every 60 seconds:

```bash
FILE="$AGENT_OUTPUT_FILE"
cat "$FILE" | python3 -c "
import sys, json
tool_calls = 0; screenshots = 0; skill_reads = 0; writes = 0; edits = 0
files_written = []; last_texts = []
for line in sys.stdin:
    try:
        d = json.loads(line)
        if d.get('type') == 'assistant':
            for c in d.get('message',{}).get('content',[]):
                if isinstance(c,dict):
                    if c.get('type')=='text' and len(c.get('text',''))>20:
                        last_texts.append(c['text'][:200])
                        if len(last_texts) > 3: last_texts.pop(0)
                    elif c.get('type')=='tool_use':
                        tool_calls += 1
                        n=c.get('name','');inp=c.get('input',{})
                        if n=='Bash':
                            cmd = inp.get('command','')
                            if 'screenshot' in cmd.lower(): screenshots += 1
                        elif n=='Write':
                            writes += 1; files_written.append(inp.get('file_path','').split('/')[-1])
                        elif n=='Edit': edits += 1
                        elif n=='Read':
                            fp = inp.get('file_path','')
                            if 'SKILL.md' in fp or 'visual-dev' in fp: skill_reads += 1
        if d.get('type') == 'result': print('*** AGENT COMPLETE ***')
    except: pass
print(f'Calls: {tool_calls}/80 | Screenshots: {screenshots} | Skills read: {skill_reads} | Writes: {writes} | Edits: {edits}')
print(f'Files: {files_written}')
for t in last_texts: print(t[:150]); print('---')
"
```

At each check, update the monitoring table:

| Agent | Calls | Screenshots | Skills | Files | Notes |
|-------|-------|-------------|--------|-------|-------|

**Phase 1 watch for:**
- Elimination table progress
- Route count
- Infrastructure waste (pnpm retries, sleep loops)

**Phase 2 watch for:**
- Screenshot frequency — 20+ calls without a screenshot = building blind
- State enumeration — should happen in first 5-10 calls
- Skill file reads — should read dashboard-builder + visual-dev early
- Component granularity — one 500-line file vs multiple small files
- Route group placement — page should be under `(dashboard)/`, not top-level `/app/`
- shadcn/ui coverage — check for raw `<button>` or raw `<div>` for errors
- API_PORT set correctly when web server started

**Phase 3 watch for:**
- Did reviewer read all component files?
- Did reviewer read all 4 viewport screenshots + wireframe?
- Are findings GENERALIZED or site-specific?

**Budget overrun:** If an agent exceeds its budget, let it finish its current output but note the overrun. In findings, check whether the overrun was caused by a monolith rewrite (instruction gap) or unnecessary retries (agent error).

## Scorecards

### Discovery Scorecard

Same as `.agents/skills/instruction-tuning/SKILL.md` — the existing 18-check table.

### Builder Scorecard

| Check | Pass/Fail |
|-------|-----------|
| Read all 4 skill files before starting | |
| API routes verified via curl before UI work | |
| States enumerated BEFORE writing component code | |
| Built component-by-component, not whole page blind | |
| Screenshot taken after EVERY visual change | |
| 7 judgment criteria applied to each screenshot | |
| Wireframe compared against dashboard screenshot | |
| Fixed issues one at a time between screenshots | |
| All states rendered: idle, loading, populated, empty, error, detail | |
| Mobile viewport (375px) screenshot taken and judged | |
| Data flows through /api/ proxy — no hardcoded URLs | |
| Used shadcn/ui components — no reinvented primitives | |
| Component files under 200 lines each | |
| No @interceptor/shared imports in client components | |
| Biome auto-fix run before manual lint cleanup | |
| Stayed under 80 tool calls | |

### Reviewer Scorecard

| Check | Pass/Fail |
|-------|-----------|
| Read all worktree source files (components, routes, types) | |
| Read dashboard screenshots at all 4 viewports | |
| Read the wireframe screenshot | |
| Compared wireframe to dashboard (named specific differences) | |
| Produced Section A with >= 3 instruction improvement findings | |
| All Section A findings are GENERALIZED=yes | |
| Produced Section B with >= 1 framework code fix | |
| Did NOT suggest changes to the worktree code | |
| Each finding includes specific file path and exact text change | |
| Scored the dashboard on the 12-point review | |

## Findings Flow

```
REVIEWER produces findings report
         │
    ┌────┴────┐
    ▼         ▼
Section A:   Section B:
Instructions Code Fixes
    │         │
    ▼         ▼
.claude/     packages/
skills/      apps/ etc.
    │         │
    └────┬────┘
         ▼
CONSISTENCY CHECK
(grep .claude/ for contradictions)
         │
         ▼
   COMMIT + HANDOFF
```

The orchestrator is the ONLY entity that writes to `.claude/`. The reviewer produces a report. The builder writes to the worktree. No agent ever writes to `.claude/` directly.

## Consistency Check

When you change an instruction, the same concept appears in multiple files. A fix in `dashboard-builder/SKILL.md` means nothing if `dashboard-agent.md` still uses the old language.

**Before committing any instruction change:**
```bash
grep -rn "CONCEPT" .agents/rules/ .agents/agents/ .agents/skills/
```
Every hit must be consistent with your change.

## Port Allocation

| Worktree | API Port | Web Port |
|----------|----------|----------|
| dash-1   | 3031     | 3041     |
| dash-2   | 3032     | 3042     |
| dash-3   | 3033     | 3043     |

Avoids collision with discovery agents (3011-3021) and user dev (3000-3001).

## Session Handoff

After committing all fixes, write `.claude/dashboard-tuning-handoff.md` (gitignored) with:

1. **Iteration number**
2. **Wireframe used** — what website was the target
3. **Phase 1 results** — routes discovered, transports found, tool calls used
4. **Phase 2 results** — components built, screenshots taken, tool calls used
5. **Phase 3 results** — reviewer score (out of 24), findings count
6. **Findings applied** — which instruction changes were committed
7. **Findings deferred** — which findings need more data
8. **What's next** — specific items for the next iteration

## Generalization Rule

Every instruction change must work for ANY website. If a fix only helps for a specific site, it's overfitting. The reviewer must mark GENERALIZED=yes on every finding. The orchestrator drops GENERALIZED=no findings.

## Convergence

The dashboard tuning loop converges when fresh builder agents (clean session, no hints):
1. Read all skill files and follow prescribed phases in order
2. Enumerate all visual states before writing code
3. Screenshot after every visual change and apply 7 judgment criteria
4. Compare against wireframe, identify and fix layout gaps
5. Build component by component, keep files under 200 lines
6. Score 20+ on the reviewer's 12-point review
7. Stay near 80 tool calls
