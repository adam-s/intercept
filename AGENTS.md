# AGENTS.md

Canonical instructions for coding agents in this repo. Agent-specific entry
points (e.g. [CLAUDE.md](CLAUDE.md)) reference this file; shared resources
(skills, references) live under [.agents/](.agents/), and path-scoped procedures
under [.agents/rules/](.agents/rules/).

**This file holds generalized principles and policy only — never a specific
fact, path, constant, name, or recipe.** Project specifics live where they can
be verified and version-controlled: [docs/](docs/), tests, script docblocks, and
code comments. If a rule here names a particular instance, it's in the wrong
place — rewrite it as a principle, or move the fact to the code. Any example
below is one illustration of many, not a spec. A repo-level test pins this: it
fails on a host, port, shell command, or call budget appearing in this file.

## Language & voice

- Do not use "kill" except for the Unix `kill` command. Use stop / end / halt /
  exit / close / cancel / interrupt / terminate / abort.
- Do not use "adversary" or "adversarial." The work is bug-hunting, break-it
  testing, or skeptical review — name it that way.
- Frame with positive language over negative. Make the subject of a sentence the
  capability and the good it produces, not the harm it prevents or the failure
  it embodies — negative, charged, or violent imagery reads as motiveless menace
  to a reader who lacks the surrounding context, and it casts the writer's own
  work as the villain instead of the hero. This binds hardest on any
  outward-facing copy, where the reader arrives cold. Swap the charged word
  while keeping the candor; reframing is not sanitizing, so never drop the
  honest substance to reach for the nicer tone. E.g. "catches routes that
  silently serve a bot-wall page as data" → "routes only return data they
  proved they received"; "this tooling can be abused" → "this tooling is best
  aimed where it does good."
- **Every phrase an outside reader will see gets a connotation pass before it
  ships** — README copy, page text, labels, titles, route names, URLs. Read each
  phrase three ways: what it literally claims (true and precise?), what it
  implies about the writer, and every second parse a cold skimmer could take;
  the worst reasonable reading is the reading. Rewrite what fails — candor kept,
  reading fixed.
- Explanatory prose: constraint first, then why the naive approach fails, then
  the actual mechanism — plain declarative sentences. Reference-shaped content
  (contracts, schemas, tables) is rigid, predictable, and enthusiasm-free.
  Anti-slop rules live in [.agents/reference/](.agents/reference/) and apply to
  every doc, comment, and commit message.
- **A decision that supersedes a recorded rule retires the record in the same
  breath.** Update or banner every place the old rule is written before the work
  moves on — a superseded rule left standing will be faithfully obeyed by the
  next agent that reads it.

## Orientation

What this project is, how the tree is laid out, which command starts what, and
which ports things bind live in [docs/](docs/) — read them before building. The
reference domain is executable documentation: it carries working code for every
transport type, and reading it beats inventing a shape.

## Iteration

1. **Plan first.** Scope the work and its "done when" gate before starting.
   Don't build what the maintainer hasn't asked for.
2. **Probe before building.** When behavior is uncertain, write an empirical
   probe and observe. Facts, then code. Unverified assumptions stay labelled
   until a probe confirms them. **When a pipeline contains an expensive,
   hard-to-repeat step — a live browser session, a session-gated capture, a
   rate-limited target — everything cheaply verifiable beforehand is verified
   automatically, every run. A failed precondition must never be discovered by
   the expensive step failing.**
3. **Unexpected output is the answer, not a prompt to retry.** Markup where JSON
   was expected, a rate-limit status, an empty body — each is a finding. Read
   the status, the content type, and the body. Re-sending the same request with
   a tweaked header or a pause between attempts does not change it, and it
   spends the budget that would have found the real cause.
4. **Pin what you fix.** Every fixed behavior gets a regression test; every
   locked-down interface gets a contract test.
5. **An obligation without a gate is a suggestion.** An instruction is followed
   in proportion to whether something checks it, not to how clearly it is
   written — two obligations stated in the same voice, in adjacent lines, are
   obeyed and ignored according to which one a running check covers. So every
   obligation added to an instruction file names the check that enforces it, in
   the same change. If no check can be named, write the check first or drop the
   obligation; a rule that only a conscientious reader honours is a rule that
   quietly stops being true. The same logic upgrades guidance that keeps
   getting missed: the fix is a gate, not a firmer sentence.
6. **Break-it review at checkpoints.** Review the production code, then the
   tests, then mutate the code to confirm the suite actually bites.
7. **Record, generalized.** Accepted tradeoffs are recorded where the knowledge
   lives — a code comment, a doc, a script docblock. A rule added here must
   generalize: if you can name the failing instance in the rule, it's a fact,
   not a rule.
8. **Pinned lessons are re-probeable.** A pin records what a probe showed
   *then*, not eternal truth. When new evidence contradicts one, re-probe and
   update the pin, saying what changed and when — a stale lesson misdirects the
   next agent as surely as a missing one.
9. **Repeated difficulty is itself a finding.** Several approaches to one
   problem means the problem is misunderstood. Stop, write down what each
   attempt disproved, and re-probe.

## Durable knowledge — no memory systems

Do not use assistant memory for anything about this project, and do not route
work through a memory file. Durable knowledge lives only in version-controlled,
reviewable files: this file (principles and policy), the docs, the skills and
references, script docblocks, or code comments (a constraint the code can't
show). If something is worth keeping, put it in the file that owns it before the
session ends; if it only matters to the current conversation, it doesn't need
keeping.

A fix belongs in the file it fixes. Queueing one in a scratch note for a later
branch loses it — write the fix where it lives, or don't record it.

Pasted context (handoffs, roadmaps, briefs, plan documents) is briefing, not a
work order. The maintainer directs what gets built.

## Tools we don't use

- **Assistant memory** — as above.
- **Self-scheduling** (a tool that schedules its own future runs). Don't propose
  it or reach for it when a task has a natural cadence. Recurring or
  future-dated work is handled inline or by the maintainer asking, never by an
  agent scheduling itself.

## Principles

- **We own all of the code.** Packages, apps, domains, scripts, test server,
  infrastructure. When something is broken, fix it at the source with
  production-quality code. No workarounds, no "document it for later," no dummy
  value to satisfy a type. If an interface is wrong, fix the interface.
- **No holds barred.** Breaking changes are fine — this is pre-release. Delete
  dead code, rename freely, change interfaces. If the cleanest path is a
  teardown, take it. Tests must pass afterward.
- **Run unsupervised.** When multiple paths work, pick the best, take it, keep
  going.
- **Default to the lighter thing.** Justify any heavier choice with a hard
  constraint, a safety issue, or a concrete failure the choice responds to.
- **Generalize over specify.** Write the principle, not the recipe. Recipes age;
  judgment doesn't. A procedure precise enough to be a recipe belongs in a
  script, where it either runs or fails loudly — not in prose, where it rots
  silently and nobody finds out.
- **Separate reusable from specific.** Code any target would want lives as a
  reusable library; content specific to one target lives in its own place and is
  treated as a template that scales to many instances, not a one-off. Entry
  points stay thin — they wire libraries together, they don't hold logic. A
  cross-cutting concern (logging, rate limiting, session storage, an assertion)
  belongs in one place with one API, never re-implemented per caller.
- **Two tools are duplication only when they do the same job.** A
  cross-cutting concern belongs in one place, and that rule is about
  *overlapping* implementations — two things answering the same question, where
  neither can contradict the other and a wrong answer survives in both. Two
  tools that each cover what the other structurally cannot are a seam, not a
  duplicate: name the boundary, say why it exists, and keep both. The same holds
  for process — two passes with different instruments beat one pass with a
  compromised instrument whenever the total cost is lower, and forcing unity has
  a cost too. What is never acceptable is an unexplained overlap, or a seam
  nobody wrote down: the next reader deletes one side as redundant and loses
  whatever only it could see.
- **The first consumer is an instance, never the definition.** A reference
  implementation demonstrates the framework; it does not become the framework by
  being first.
- **Shipped means reachable.** A capability no workflow can invoke does not
  exist yet, however finished the code is. Building the library and leaving the
  entry point for later produces a thing that passes its tests, reads as done,
  and changes nothing — and the gap is invisible precisely because every part in
  isolation looks complete. The last step is wiring it to the place someone
  actually starts from, and until that step lands the work is unfinished rather
  than merely unpolished.
- **A claim about several configurations is verified on each.** Support for a
  set — engines, platforms, modes — that was checked on the convenient member is
  support for that member and a guess about the rest. Verify each, or narrow the
  claim to what was tested. The tempting shortcut is a shared abstraction that
  "should" behave identically; shared code is exactly where a per-configuration
  difference hides, because nothing in the source shows it.
- **Simplicity over complexity.** Reach for complexity only when the problem
  genuinely requires it.
- **Bind to identity, not ordinal.** A positional index into an external,
  mutable collection is not a stable handle: the collection reorders and the
  same position silently resolves to a different member. Resolve by intrinsic
  identity and fail loudly when it is absent.
- **Keep the answer out of the exam paper.** When an artifact will be read by a
  model or person whose independent judgment is the thing being demonstrated —
  an instruction-tuning run, a review, a break-it pass — the artifact must not
  contain the expected outcome. Naming the intended finding contaminates the
  proof; the demonstration's whole value is the independence it forfeits.
- **Capture ground truth; don't reconstruct it.** When a later step needs a fact
  — a response shape, a token's expiry, an indicated total — record it at the
  source, in-band, so it is a property of the captured data rather than
  something inferred afterward. A derived artifact cannot yield up a detail the
  capture never wrote down.
- **Leave no mess.** Every artifact has one deliberate home and a lifecycle: it
  follows the naming convention of the folder it lives in, and it is deleted the
  moment its purpose ends. Probe output, spent captures, and scratch work never
  linger next to real material. Stop every process and free every port you bound
  before finishing or switching context.

## Product invariants

Load-bearing to the product, not to any one module; breaking one is a regression
regardless of what else improves. The mechanisms and the rationale live in the
docs and at the code sites.

- **The browser is the API client.** Reach for the browser-context fetch first,
  because it already holds the session that makes the request work. Direct HTTP
  is the last rung, reached only after elimination has proved what the endpoint
  actually requires.
- **The transport ladder is typed, not advisory.** A host proved to need the
  browser refuses plain HTTP at the call site, and a bot-wall interstitial
  raises rather than being returned as data. A route must never parse a
  challenge page into a result.
- **Elimination precedes any route code.** The transport elimination table is a
  gate: every transport row carries a present-or-absent verdict with evidence
  before the first route is written, and evidence means captured output rather
  than recollection.
- **Discovery explores breadth; it never targets named endpoints.** Naming a
  specific route up front produces tunnel vision and misses the transports that
  only appear under interaction. Let the protocol find them.
- **A route reports what it actually got.** Item count against indicated total,
  and an explicit incomplete signal when the two disagree. Silent truncation is
  the defect this invariant exists to prevent.
- **Give-up is a first-class, reported outcome** — never hidden behind a
  fabricated success, a placeholder value, or a partial result presented as
  whole.
- **Observation must not become the cause.** Every aid that makes a system
  legible — an instrumented runtime, a synthetic interaction, an elevated
  request rate — is detectable by the system being observed, so the pass that
  has to succeed carries none of them. Learn with the aids on a disposable
  session; do the real work with them removed and the environment handed back as
  it was found. A failure recorded while the aids were running is evidence about
  the run, not about the target, and must be re-tested without them before it is
  written down as a property of anything.
- **Outward-facing actions stay behind a human checkpoint.** Deploying,
  rebuilding production images, wiping a database, and driving traffic at a live
  third-party site are all outward-facing: they run attended, with the
  maintainer's recorded consent, and never inside an unattended loop.
- **Captured session material is never distributed.** Browser profiles, cookies,
  tokens, and environment files stay out of git, out of copies handed to
  sub-agents, and out of anything published.
- **`main` is the product; test branches are disposable.** Framework code,
  instructions, and skills live on `main`. Domain plugins, their profiles, and
  their dashboards are ephemeral. The invariant to preserve: deleting every test
  branch loses nothing of lasting value.

## Correctness-critical facts

The specific keys, formats, constants, selectors, and shapes a fresh agent could
break each get a pinned regression test and live at the code site — a comment, a
contract, or a test — not in this file. A silent break of one is exactly what
break-it review exists to catch.

## Tests + build

- **Static green is the floor.** Lint, build, types, and tests all clean before
  any commit. The gate command lives with the code, in `package.json` and the
  docs.
- **Repo-level pins run too.** Package suites don't reach checks that belong to
  the repo rather than to a package; those get their own run, and it is part of
  the gate.
- **Prove a new check fails.** A test that has never been red is a claim, not a
  check.
- **Absence of a result reads exactly like a pass.** A check that never ran, a
  case that was skipped, a probe cut off by a budget, a suite that failed to
  load, an action that found nothing to act on — none of them report a failure,
  because none of them report anything. So anything that can decline to act says
  so in its output, with the reason; and a count is read for whether it moved
  the way the change implies, not only for whether it contains failures. A new
  check that added no cases did not run. Break the thing it guards, watch it go red, restore.
- **Dynamic scripts are bounded** — a hard cap on requests, wall time, output
  size, or scenarios, stated in the header docblock and enforced in the code. No
  model judgment inside a script. Importing a script runs nothing, so a unit
  test can drive its real logic over a fixture with no network.
- **A passing run cleans up after itself; a failing run leaves its artifacts in
  place for inspection and exits non-zero.**
- **Stage files by name.** Never stage the whole tree — an all-inclusive add
  sweeps in captures, profiles, and scratch output that must not be committed.
- **Large binaries and captured profiles stay out of git.**

## Debug and logging

One debug module, one API, file-and-console output. When stuck: hypothesize →
add targeted logging at the hot spot → reproduce → narrow → fix → then remove
the logs or downgrade them to permanently useful ones. Don't leave stale "I was
debugging this" logs behind.

**Read logs bounded.** Grep for the signal first, then read a fixed number of
lines around it. Log files grow without limit; reading one whole costs far more
than it returns, and the cost is invisible until the budget is gone.

## Skills

Reusable agent playbooks live under [.agents/](.agents/) (canonical) — any
coding agent can follow them as documented procedures. Add a skill in that one
place so the canon stays single-sourced; the folder layout, the `SKILL.md`
shape, and the auto-discovery symlink are recorded in
[.agents/reference/](.agents/reference/).

Two families that look similar and are not, so nobody merges them later:

- **Break-it review skills** examine *this repo's code and tests*. They are
  read-only against production code; the mutation one works in an isolated copy.
- **Instruction-tuning skills** test whether *sub-agents follow the
  instructions*, using throwaway output as the measurement. The instruction and
  framework improvements are the product; what the sub-agents build is not.

### Cross-model break-it review

The in-repo skills spawn a sub-agent in one model family. For a cross-family
check, the maintainer runs the same prompt template out-of-band and pastes the
findings back unedited — never edit a tuned template to make the external review
easier. Triage by severity as with in-tool output; a different-family finding is
not automatically more authoritative. Verify against the actual code, and read
closely where the reviewers disagree.

## Deferred findings

A review or break-it finding is either fixed-and-pinned with a regression test,
or accepted with reasoning — never quietly dropped. Accepting one is an explicit
act, and the entry lives where the knowledge lives (a comment at the code site,
or the relevant doc), so the next agent neither "fixes" it ad hoc nor builds on
it unaware.

## Noise

Don't chase cosmetic churn. Generated files (build-tool ambient types, framework
internals, lockfiles) and doc-linter nits are not action items.

## Naming

Match the project's canonical name and casing consistently — across package
scopes, route prefixes, script names, and artifact directories.
