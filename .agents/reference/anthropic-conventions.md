# `.claude/` Anthropic conventions — quick reference

Distilled from Anthropic's official Claude Code docs and
`github.com/anthropics/skills`. **Authoritative source** is the official docs;
this file only exists so we don't reinvent formats. Re-research if formats
change.

- Skills: https://code.claude.com/docs/en/skills
- Hooks: https://code.claude.com/docs/en/hooks
- Sub-agents: https://code.claude.com/docs/en/sub-agents
- Settings: https://code.claude.com/docs/en/settings
- Settings JSON Schema: https://json.schemastore.org/claude-code-settings.json
- Examples: https://github.com/anthropics/skills

---

## Skills — `SKILL.md` in a named folder

Required frontmatter: `name`, `description`. Everything else is optional.

```markdown
---
name: my-skill
description: What it does + when to use it. Description is keyword-matched for auto-discovery — front-load the trigger phrases ("discover an API", "capture traffic", "build a dashboard"...).
allowed-tools: Bash(node *), Read, Write       # pre-approve specific tools/commands
disable-model-invocation: false                # true = user-invoked only (no auto-triggering)
user-invocable: true                            # false = Claude-only, hidden from slash menu
model: sonnet                                   # override session model for this skill's work
effort: high                                    # low | medium | high | xhigh | max
context: fork                                   # 'fork' = run in subagent, isolated context
agent: Explore                                  # which subagent type if context: fork
paths: src/**/*.ts                              # auto-load skill when files matching glob are touched
argument-hint: "[label]"                        # CLI autocomplete hint
arguments: [label, users]                       # named positional args (CLI)
---

# Skill body — the instructions Claude follows

Keep the main SKILL.md focused (target ~500 lines max). For long supporting
material, bundle alongside and reference:

- `reference/<topic>.md` — detailed docs, lazy-loaded
- `scripts/<helper>.sh` — executable utilities
- `templates/<file>.template` — scaffolding inputs
```

**Folder layout** (this repo puts skills under `.agents/skills/`, see the Drift
check below):

```
.agents/skills/my-skill/
├── SKILL.md        # required
├── reference/      # optional
├── scripts/        # optional
└── templates/      # optional
```

**Two patterns:**

1. **Skill-as-prompt-template** (the red-team triad): the SKILL.md body is a
   template the agent fills in and hands to the `Agent` tool. No scripts.
2. **Skill-as-procedure** (`api-discovery`, `ci-check`): the body documents a
   sequence the agent walks, with the gates and stops made explicit.

---

## Hooks — configured in `settings.json`, NOT separate files

Hooks live in `.claude/settings.json` under the `hooks` key. The
`.agents/hooks/` directory holds the *referenced* shell scripts, not config.
They live under `.agents/` rather than `.claude/` because a shell script is
portable; only the wiring that names it is Claude-Code-specific.

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.agents/hooks/guard-worktree-writes.sh",
            "timeout": 10,
            "statusMessage": "Checking worktree isolation"
          }
        ]
      }
    ]
  }
}
```

**Hook types:** `command` (shell), `http` (POST), `prompt` (Claude evaluates),
`agent` (spawn subagent).

**Event types:** `PreToolUse`, `PostToolUse`, `SessionStart`, `CwdChanged`,
`FileChanged`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `WorktreeCreate`.

**Hooks are how an automated behavior becomes deterministic.** Prose in a skill
cannot make the harness run something every time; a hook can.

---

## Sub-agents — `.agents/agents/<name>.md` (`.claude/agents` symlinks to it)

```markdown
---
name: reviewer-agent
description: Reviews worktree code and screenshots. Use after a build iteration.
tools: Read, Bash, Grep, Glob                # whitelist
disallowedTools: Write, Edit                 # blacklist (read-only enforcement)
model: sonnet
maxTurns: 5
isolation: worktree                          # run in a fresh git worktree
permissionMode: default
---

You are a senior code reviewer. Return specific, actionable findings.
```

**Custom agent vs inline `Agent` call:** a custom agent is for *recurring*
delegation the maintainer wants visible in the agent picker. One-off delegation
uses an inline `Agent` call.

---

## Rules — `.agents/rules/<name>.md` with `paths:` frontmatter

The `paths:` mechanism is Claude-Code-specific — rules load *conditionally*, by
glob, when matching files are touched — but the procedures themselves are not,
so they live under `.agents/` with `.claude/rules` symlinked for
auto-discovery. Another agent reads them as plain path-scoped documents.

```markdown
---
description: One line shown when the rule loads
paths:
  - "domains/**"
  - "apps/web/src/app/(dashboard)/**"
---
```

A rule with no `paths:` is ambient — it loads every session, so it competes
with AGENTS.md for the same budget. Prefer scoping. This is the one convention
in this file with no counterpart in the sibling repos; they use a single flat
AGENTS.md, which for a monorepo with `domains/**`, `apps/web/**`, and
`packages/**` would load every procedure into every session.

**Division of labor, so the two files don't drift into each other:**

| File | Holds |
|---|---|
| `AGENTS.md` | Generalized principles and policy. No specific fact, path, constant, or recipe. |
| `.agents/rules/*.md` | Path-scoped *procedures* — the steps for work in one part of the tree. |
| Code comments | Anything guarding a specific implementation. |
| `scripts/*.mjs` docblocks | Bounds, usage, and the exact commands. Enforced, not described. |

---

## Settings — `.claude/settings.json` (committed) and `settings.local.json` (gitignored)

```jsonc
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": ["Bash(pnpm vitest *)", "Bash(node scripts/*.mjs *)"],
    "deny":  ["Read(./.env*)"]
  },
  "env":     { "DEBUG_LOGGING": "true" },
  "hooks":   { /* see Hooks section */ },
  "model":   "opus",
  "effort":  "high",
  "mcpServers": { /* MCP server defs */ }
}
```

**Scope precedence (higher wins):**

1. `~/.claude/settings.json` (user, all projects)
2. `.claude/settings.json` (project, committed)
3. `.claude/settings.local.json` (project, gitignored — local overrides)
4. Org/managed settings (above all)

---

## Drift check — what's in this repo

**Every agent-shared artifact lives in `.agents/` (canonical) so it works across
coding agents.** Root `AGENTS.md` holds the project instructions and root
`CLAUDE.md` imports it via `@AGENTS.md`. `.claude/` keeps only what is genuinely
Claude-Code-specific — `settings.json` — plus symlinks (`CLAUDE.md`, `skills`,
`rules`, `agents`) so auto-discovery still resolves. Hook scripts need no
symlink: `settings.json` names them by absolute path.

The test that a change respects this: a coding agent that has never heard of
`.claude/` can read `AGENTS.md`, follow it into `.agents/`, and find everything.

Rows are claims. The mechanically checkable ones are pinned by
[conventions-drift.test.mjs](../../scripts/__tests__/conventions-drift.test.mjs);
re-verify the rest against the tree before relying on them.

| Artifact | Status | Notes |
|---|---|---|
| `AGENTS.md` (root) | ✓ aligned | Canonical project instructions, cross-agent |
| `CLAUDE.md` (root) | ✓ aligned | Thin `@AGENTS.md` import + entry-point note |
| `.claude/CLAUDE.md` | ✓ aligned | Symlink → `../AGENTS.md` |
| `.claude/skills` → `.agents/skills` | ✓ aligned | Symlink; skill folders keep the standard `SKILL.md` shape |
| `.agents/skills/api-discovery/` | ✓ aligned | Discovery protocol entry point; carries `reference/`, `scripts/`, `templates/` |
| `.agents/skills/app/` | ✓ aligned | Plain-language app build — asks, discovers, then builds a dashboard |
| `.agents/skills/ci-check/` | ✓ aligned | Local CI + GitHub Actions status |
| `.agents/skills/dashboard-builder/` | ✓ aligned | Next.js pages against domain proxy routes |
| `.agents/skills/debug-logs/` | ✓ aligned | Targeted-log debugging loop; reads are bounded (grep-first, `tail -n`) |
| `.agents/skills/ec2-deploy/` | ✓ aligned | Outward-facing; behind the human checkpoint |
| `.agents/skills/instruction-dashboard-tuning/` | ✓ aligned | Sub-agents as test subjects for the dashboard instructions |
| `.agents/skills/instruction-tuning/` | ✓ aligned | Sub-agents as test subjects for the discovery instructions |
| `.agents/skills/recorder-capture/` | ✓ aligned | Last-rung escalation: record a human flow, replay its real motion. Keystroke content is never captured |
| `.agents/skills/red-team-review/` | ✓ aligned | Bug hunt over production code (proxy routes, session handling, pagination) |
| `.agents/skills/red-team-test/` | ✓ aligned | Bug hunt over the suite itself — fixture lies are the local hazard |
| `.agents/skills/red-team-mutation/` | ✓ aligned | Injects regressions in a `/tmp` copy; the copy excludes `data/browser-profiles/` and `.env*` |
| `.agents/skills/systematic-testing/` | ✓ aligned | Bottom-up layer validation |
| `.agents/skills/visual-dev/` | ✓ aligned | Screenshot-and-judge loop; carries `reference/` |
| `.agents/reference/` | ✓ aligned | `anti-slop.md` (byte-identical across sibling repos), `anthropic-conventions.md` (this file) |
| `.agents/rules/` | ✓ aligned | Path-scoped procedures — see the Rules section. Ahead of every sibling repo, which have no equivalent |
| `.claude/rules` → `.agents/rules` | ✓ aligned | Symlink, for Claude Code auto-discovery |
| `.agents/agents/` | ✓ aligned | `discovery-agent`, `dashboard-agent`, `reviewer-agent`. Sibling repos list this row `not used` |
| `.claude/agents` → `.agents/agents` | ✓ aligned | Symlink, for Claude Code auto-discovery |
| `.agents/hooks/` | ✓ aligned | `WorktreeCreate` scaffolding, `SubagentStop` cleanup, `PreToolUse` worktree-write guard. Referenced by absolute path from settings.json, so no symlink is needed. Sibling repos list this row `not used` |
| `.claude/settings.json` | ✓ aligned | Hooks only. No committed `permissions` or `env` block yet |
| `.agents/assets/` | not used | No operator chimes in this repo; the sibling two-chime convention is not adopted |
| `.claude/settings.json` → `permissions` | not used | Candidate: an allow-list for the bounded scripts once their flags settle |

## Deliberate divergence from the sibling repos

- **`.agents/rules/` with `paths:` frontmatter.** No sibling uses it; they run a
  single flat AGENTS.md. This repo is a monorepo whose procedures are
  tree-local, so conditional loading is the better fit. Recorded here so the
  next agent doesn't "fix" it by flattening.
- **Hooks and sub-agents are live.** Every sibling marks both
  rows `not used`. Keep them; they are the reason worktree isolation and
  sub-agent cleanup are enforced rather than described.
- **No `.agents/assets/` operator chimes.** `job-hunter` and `callbench` play a
  two-chime signal (your move / done). Not adopted here — this repo's long runs
  are already attended.

## When to update this file

- A skill, hook, agent, rule, or settings field doesn't behave the way this doc
  says
- Anthropic ships a new artifact type or deprecates one
- A pattern here diverges from the canonical shape and needs recording as a
  deliberate exception

The drift test fails on a missing skill row or a moved symlink; everything else
rots silently, so re-read it when the tree changes. If in doubt, re-fetch the
official docs URLs at the top.
