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
