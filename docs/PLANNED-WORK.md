# Planned work

Decisions already made, not yet built. Each entry says what was decided and why,
so the next session starts from the decision rather than re-litigating it.
Delete an entry when it ships.

## Tuning iterations — next

Run the instruction-tuning skills **one or two iterations at a time**, not in a
long unattended sweep. The maintainer reads each result before the next starts.

The two tuning skills test different things and stay separate:
`instruction-tuning` measures whether a sub-agent follows the discovery
protocol; `instruction-dashboard-tuning` measures the dashboard build. Both
produce throwaway artifacts — the instruction and framework fixes are the
product.

Two changes from this session that the next tuning run should exercise, because
both altered what an agent is told to do:

- `.agents/rules/discovery.md` no longer carries literal request recipes; it
  points at `scripts/discover-probe.mjs`. A tuning run shows whether an agent
  reaches for the script or improvises requests anyway.
- AGENTS.md is principles-only. A tuning run shows whether an agent still finds
  the facts it needs in `docs/` and the script docblocks.

## UI skills — later, adopt the `ui-explore/loop` method

**Decided:** replace the current screenshot-and-judge loop with the
spec-driven method from `~/Projects/callbench/packages/ui-explore/loop`.

**Why it should be cheaper.** The present loop renders a page, looks at the
image, judges it, and iterates — every cycle pays for image analysis, and the
judgment is not reproducible between runs. The `ui-explore` method inverts it: a
frame is read *once* into a written description, the build is made from that
description alone, and the comparison is description-against-build. The contract
is text, so a cycle costs a text diff rather than a picture, and a disagreement
points at a specific line someone can correct.

`loop/README.md` there is the method plus the accumulated rules that came out of
running it; `loop/descriptions/` holds one description per frame, and every
screen cites the description it was built from and nothing else.

**What to port when we get to it:**

- The description format, and the rule that a build cites exactly one
  description
- The comparison step — build-versus-description, not build-versus-picture
- The accumulated rules section, which is the part that compounds

**What not to port:** the ownership block at the top of that README is a
standing instruction specific to callbench's arrangement, not a general rule.
Also that package's research corpus stays where it is.

**Open question for the maintainer:** intercept2's dashboards are generated from
discovered APIs rather than read from reference frames, so "the description" has
a different source here — a route's response shape rather than a screenshot.
Whether the method survives that substitution is the first thing to test, and it
is cheap to test on one page before committing to the port.

## Deferred before the next tuning round — watch for instruction-induced regressions

Items 1–4 of the pre-tuning list landed. These six were deliberately left, and
each is written here rather than carried in anyone's head. The reason to record
them together is that the next tuning round is also the first test of a large
batch of new instructions, and a regression caused by our own guidance looks
exactly like a regression caused by a target.

**Watch specifically for the instructions making things worse.** Every rule
added this round narrows what an agent may do: a two-pass split, a derived
elimination table, two new route-spec gates, a reference domain that now
demonstrates seventeen transports. Each is a hypothesis. If breadth drops, or
runs get slower without finding more, or agents start reporting confusion, the
new guidance is a suspect and not merely an innocent bystander. Suppress one
rule at a time to find out, the same way aids come off one at a time — the first
removal that restores the old behaviour names the cause.

| # | Item | State |
|---|---|---|
| 5 | Interaction sweep validated | **Done.** Measured against a fixture carrying transports that appear only after interaction: 8 transports and 16 call shapes without it, 9 and 22 with it, all three gated endpoints found only with it. The comparison found the sweep's element actions had never worked on any site. |
| 6 | `--record` replaces a baseline instead of merging | Open. A route with two legitimate shapes loses one. Hit once on a rate-limit-fallback route; the data was repaired by hand and the tool still has the defect. |
| 7 | Challenge detection | **Done.** The manifest names any bot-protection vendor it saw and states that a refusal from an instrumented run cannot be recorded as the site's policy until repeated clean. |
| 8 | Worker-scoped traffic | **Done.** Capture runs on Playwright's context-level events, which see a worker's own requests; verified against the fixture and against a live site that fetches media from a worker. |
| 9 | Domains are still ephemeral by rule | Open. Folding them in retires three records that must move together: the ignore rule, the base-branch rule, and the product invariant. A superseded rule left standing gets obeyed. |
| 10 | `transport` is typed as a bare string | Open. Reconciled only by a repo test against the reference domain, so a typo fails CI rather than the compiler. Accepted deliberately: the canonical list lives in plain JavaScript the TypeScript cannot import, and duplicating it would create the two-lists drift this project keeps paying for. |

Also known and accepted for now: the camoufox capture path cannot be benchmarked
unattended, because that driver refuses true headless by design. Its recall was
verified headed at 13/13; any future claim about it needs the same attended run.

## Resolved: capture is one implementation per concern

A live Twitch run reported `HLS/Media` absent while the video played. The cause
was structural: the remote service ran its own CDP capture bound to the page,
and the driver's `traffic-capture.ts` — written to replace it — was not what
executed. Two implementations, with the unused one's docblock claiming it had
already replaced the other.

Full unification was attempted and does not work, which is worth recording so
nobody attempts it again. Playwright's listener never sees the top-level
document response for a CDP-driven navigation — measured by logging every
response the listener received, where the page's own HTML never appeared. The
CDP session, conversely, is page-bound and never sees a worker's traffic, which
is where the media went.

So the split is by concern and written down: CDP owns the navigation layer and
nothing else; Playwright owns everything the page and its workers request
afterwards. Verified live — the main document and an iframe document both
captured, worker traffic captured, and the engine's own injection URLs filtered
out (they are documents, so they survived a filter aimed at data content types).

The general form is in AGENTS.md: two tools are duplication only when they do
the same job, and a seam nobody wrote down gets deleted by the next reader as
redundant.
