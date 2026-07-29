---
name: red-team-review
description: Launch a skeptical bug-hunting code reviewer (Opus) to find real bugs, correctness issues, and trust hazards in the framework and domain proxy routes — not style nits. Use when the user asks for a "red team", "bug hunt", "break it", "find real bugs", or at checkpoints after a milestone lands.
---

# Break-it review — production code

Launches an **Opus** general-purpose agent as a skeptical reviewer of the
production code: the browser package, the API server, the shared utilities, and
the domain proxy routes.

Complementary to [red-team-test](../red-team-test/SKILL.md) (the suite) and
[red-team-mutation](../red-team-mutation/SKILL.md) (the dynamic check). Run all
three at major change points.

## When to invoke

- User says: "red team", "bug hunt", "break it", "find what's broken", "find
  real bugs"
- A significant batch of new production code just landed
- Before any deploy
- Proactively at checkpoints during long coding tasks

## How to invoke

Use the `Agent` tool with:

- `subagent_type: "general-purpose"`
- `model: "opus"`
- `description`: 3–5 words (e.g. `"Break-it review proxy routes"`)
- `prompt`: the template below

## Prompt template

Fill in the bracketed sections with real project context before invoking. Do
NOT send the template as-is — and do NOT name the bug you already suspect. The
review's value is that the reviewer found it independently.

```
You are a skeptical code reviewer performing a bug hunt on an API-interception
framework: it drives a real browser, captures a site's internal API traffic,
and exposes typed proxy routes that serve the site's data as JSON. You find
real bugs, correctness issues, and trust hazards — NOT style nits. Rank
findings by severity (CRITICAL / HIGH / MEDIUM / LOW).

## Project

Repo root: `git rev-parse --show-toplevel`.

pnpm monorepo. Read AGENTS.md first — "Product invariants" defines what counts
as broken, and docs/ARCHITECTURE.md has the layout and the ports. The reference
domain under domains/ is executable documentation for every transport type.

## What changed since last review (if applicable)

[Bullet list of notable changes with file:line anchors. If no prior review,
the full surface: packages/browser/src, packages/shared/src, apps/api/src,
domains/*/src.]

## What to hunt — this system's hazards

- **Data that isn't data.** Any path where a non-data response becomes a
  result: a bot-wall interstitial parsed as JSON, an error page whose body
  happens to parse, a 200 with an empty payload returned as an empty result
  set. The transport-tier guard in packages/shared/src/transport-tier.ts is
  supposed to prevent this class — find where a route bypasses it, catches its
  error, or reaches the network by a path that never consults it.
- **Silent truncation.** A route that returns page 1 and reports success.
  Pagination that stops on the first empty page when the API paginates
  sparsely. An item count that disagrees with the indicated total and says
  nothing. Cursor handling that loops or drops the tail.
- **Session handling.** Values harvested once and never refreshed; expiry
  checked against the wrong clock; a session written by one domain read by
  another; a refresh path that races with an in-flight request; a stored
  session that outlives the browser profile it came from.
- **Credential and capture leakage.** Cookies, tokens, profile paths, or
  environment values reaching logs, error messages, API responses, traffic
  dumps, or anything handed to a sub-agent. Query strings count — they land in
  logs.
- **Browser lifecycle.** Pool checkout/return races, a page used after close,
  traffic capture attributed to the wrong session, listeners accumulating per
  navigation, cleanup that doesn't run on the failure path.
- **Route contract drift.** Two routes for the same resource with different
  response shapes; a declared type the handler doesn't actually satisfy;
  optional fields the consumer treats as required.
- **Rate limiting.** Paths that bypass the limiter entirely, per-host state
  that leaks between domains, retry loops that multiply against the cap.

## Output format

~300–500 words. Group by severity. For each finding:
- file:line reference
- one-sentence description of the bug
- one-sentence trigger condition

Do NOT propose fixes — the bug alone. End with a one-sentence risk delta versus
the previous review if one exists. "No CRITICAL issues found" is valuable
signal; say so explicitly rather than padding the list.

Be terse. Be specific. Find real bugs.
```

## Scripts and assets

None. Helpers, if ever needed, live in this folder only.

## Cleanup discipline

**This skill cleans up after itself.** The reviewing agent is read-only by
design and should not create files.

- Temporary prompt files → delete after the agent returns.
- Scratch analysis dumps → delete unless the user asked to keep them.
- The agent's response belongs inline in the conversation. Do NOT write it to a
  `.md` file in the repo unless requested.
- Final `git status` check before returning control.

Findings accepted rather than fixed follow the Deferred findings rule in
AGENTS.md: the reasoning goes at the code site, so the next agent neither
re-fixes it nor builds on it unaware.
