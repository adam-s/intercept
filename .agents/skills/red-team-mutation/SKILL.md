---
name: red-team-mutation
description: Launch a mutation-testing agent (Opus) that injects targeted regressions into an isolated copy of the code, runs the suites, and reports which mutations SURVIVED — surviving mutations are direct evidence of test-coverage gaps. Use when the user says "mutation test", "break the code", "grade the tests", or after adding production code whose coverage is unproven.
---

# Mutation review — does the suite actually bite?

Launches an **Opus** general-purpose agent that does what a mischievous reviewer
would do if told "change this so it's broken, without the tests noticing": pick
a load-bearing invariant, silently mutate it, run the suites, and report the
verdict.

**Surviving mutations are the finding.** A SURVIVED mutation means the suite
cannot tell broken code from working code — a concrete gap pointing at an
invariant no test enforces. Complementary to
[red-team-test](../red-team-test/SKILL.md) (reads tests statically) and
[red-team-review](../red-team-review/SKILL.md) (reads production code
statically); this is the dynamic, empirical check.

## When to invoke

- User says: "mutation test", "break the code", "grade the tests", "can my
  tests catch regressions"
- After a break-it review finds a bug — confirm the regression test you added
  actually catches recurrence
- After a milestone that added production code
- Proactively on anything listed under AGENTS.md "Product invariants"

## How to invoke

Use the `Agent` tool with:

- `subagent_type: "general-purpose"`
- `model: "opus"`
- `isolation: "worktree"` — **mandatory as the outer guard**; the agent edits
  production code.
- `description`: 3–5 words (e.g. `"Mutation review route guard"`)
- `prompt`: the template below. **ONE mutation per agent.** For N mutations,
  issue N `Agent` calls in a single message.

**Copies beat worktrees for the mutation work itself.** Parallel agents that
resume after a transient error can be re-pointed at a shared worktree and
corrupt each other's verdicts. The template has each agent snapshot into its own
temp directory. A worktree alone is fine for a single, non-resumed agent.

**The snapshot excludes captured session material.** `data/browser-profiles/`
holds live cookies and a browser's full profile; `.env*` holds credentials.
Neither belongs in a copy handed to a sub-agent, and neither is needed to run
the suites. This is a Product invariant in AGENTS.md, not a nicety.

**Ports.** Suites and the test server bind fixed ports (see
docs/ARCHITECTURE.md). Parallel agents on one machine will collide. Either run
agents sequentially, or treat a port collision as verdict contamination and
re-verify.

## Choosing mutations

Do NOT let the agent pick random lines — signal-to-noise on random mutants is
terrible. Hand-pick from the Product invariants in AGENTS.md, one per agent.
Each mutation names the invariant it probes and the suite expected to catch it.

Good candidates are wherever an invariant is enforced by a single expression:

- The transport-tier guard's session-gated check, and its challenge detector —
  each should be CAUGHT by the transport-tier suite.
- A pagination loop's continuation condition, so it stops after page one.
- An item-count-versus-total comparison, so a truncated result reports complete.
- A session-expiry comparison, so a stale session is treated as fresh.
- A rate-limiter window or concurrency bound, so the cap stops applying.
- A cleanup call on a failure path, removed.

Before writing the mutation, read the code and confirm the invariant is
genuinely enforced there. A mutation to dead code produces a meaningless
SURVIVED.

## Prompt template

Fill the bracketed sections. Send ONE mutation per agent invocation.

```
You are running a mutation test. Your job is to introduce one specific
regression into production code, run the test suites, and report whether the
tests caught it. You are in an isolated git worktree — but do NOT work there
directly.

## Rules

- FIRST: snapshot the repo into your own fresh temp directory and do ALL work
  in that copy:
    rsync -a --exclude node_modules --exclude .git --exclude .next \
          --exclude data/browser-profiles --exclude 'data/fingerprint-profiles' \
          --exclude '.env*' --exclude dist \
          <repo>/ <tmpdir>/
  The profile and env exclusions are mandatory: they hold live session
  cookies and credentials. Then install dependencies inside the copy.
- Apply EXACTLY the mutation specified below. Do not invent others.
- Do not touch any test file, any file under scripts/, or any config. Mutate
  only the file named below.
- Before running suites, confirm no other process holds the ports the suites
  bind (see docs/ARCHITECTURE.md). If one does, wait or report contamination
  rather than guessing.
- Run the full gate in the copy, capturing stdout+stderr. Note which step
  failed first, if any. The exact command is in AGENTS.md §"Tests + build"
  and package.json — read it there rather than assuming.
- Revert the mutation before exiting so the worktree auto-cleans.

## Mutation

File: [ABSOLUTE PATH IN THE COPY]
Change: [EXACT BEFORE → AFTER]
Invariant probed: [one sentence — which AGENTS.md Product invariant this tests]

## Verdict

Report exactly:
- CAUGHT if any step failed after the mutation
- SURVIVED if all passed

Include the reported test COUNTS for each step. A verdict without counts is
not trustworthy — a suite that silently skipped is the usual cause of a false
SURVIVED.

For CAUGHT: name the failing test(s); one to three sentences on whether the
failure is specific to the invariant or incidental (a type error, a build
break).
For SURVIVED: state what the code now does incorrectly and what kind of test
would have caught it. No fix — diagnosis only.

## Output format

~150–300 words. Lead with the one-word verdict. Before exiting, `git status`
in the worktree must be clean. Verify and report.
```

## Verdict hygiene

A SURVIVED verdict is only as good as proof that the relevant tests actually
ran. Require in every verdict the per-step test counts, and re-verify any
SURVIVED locally — apply the mutation in the main tree, run the narrowest
relevant suite, revert — before treating it as a real gap.

Vacuous pins are the dual hazard: a test that early-returns on a missing
browser, an absent service, or an unset env var passes green while asserting
nothing. Mutation testing is exactly what exposes those. When found, replace the
guard with a stub that forces the code path to execute.

## Reading the results

- **Mutation score** = CAUGHT / total. Under 80% is a weak suite; under 50% is
  not a suite you can ship behind.
- **Surviving mutations by invariant** = the prioritized list of missing tests.
  Every SURVIVED becomes one regression test, or one accepted-with-reasoning
  entry at the code site if the invariant is genuinely unobservable.
- **Compare to prior runs.** A mutation CAUGHT last cycle that now SURVIVES
  means a recent change weakened coverage.
- A build-error CAUGHT (a type error, not a test) is weak evidence — note it;
  the invariant may still lack a behavioral test.

## Cleanup discipline

**Stricter than the other two skills**, because this agent writes code.

- Clean revert → the worktree auto-deletes. If changes are left, inspect once,
  then remove the worktree.
- Temp copies are deleted after the verdict is reported.
- Mutation output belongs inline in the conversation, not in a repo file.
- Before returning control: `git status` clean on the main tree,
  `git worktree list` shows no strays, and nothing is listening on the suite
  ports.
