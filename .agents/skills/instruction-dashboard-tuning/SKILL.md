---
name: instruction-dashboard-tuning
description: Improve the dashboard-building instructions by reading a real screen once into a written description, building from that description alone, and comparing the two. The screens are training data; this document is the product. Use when tuning how UI gets built, or when the user says "tune the dashboard instructions".
---

> Durable knowledge goes in `.agents/`, the docs, or the code. Never a memory file.

# The loop, and the document it keeps sharpening

```
describe ──▶ build ──▶ compare ──▶ generalize ──▶ PRUNE ──▶ describe the next
```

**THE INSTRUCTIONS ARE THE PRODUCT. The screens are training data.** A screen
exists to stress this file and may be thrown away. An iteration succeeds when the
guidance moved and a fresh agent would start closer — not when the screen came
out well.

**The rules here are an INPUT to the build, not only an output of the
comparison.** Repeating a mistake already written down proves this document is
text nobody reads back.

**Rebuild, don't patch.** A repaired build proves the repair; only a build made
again from the description alone proves the guidance.

**Two halves, and the first gets neglected.** Part 1 is how the screen is READ;
Part 3 is how the build is MADE. Most gaps trace to something the description
never said, and no build rule recovers a fact never recorded. Ask which half
failed before writing anything.

## Consent

This drives a browser at live third-party sites — outward-facing, so it runs
attended. Check `.agents/user-consent.md` for `ACCEPTED: true`; if absent,
present the three warnings from `instruction-tuning/SKILL.md` and write the file.

---

## Part 0 — How guidance is written

**EVERY INSTRUCTION IS GENERALIZED, NEVER SPECIFIC.** A specific may appear only
as labelled support. A rule that cannot be written without naming the site that
produced it is not yet a rule.

**A rule needs a CLASS, not an instance.** One screen doing something is an
observation and belongs in that description. It becomes a rule here when a
second, unrelated subject does the same.

**Length is itself a defect.** Every rule added makes every other rule less
likely to be consulted. Four ways to improve this file, and the last two get
forgotten: added to · corrected · **merged** · **pruned**. An iteration that adds
without merging or cutting has made it worse even when the new rule is true.

---

## Part 1 — Reading a screen so a build can be correct

**A build can only be as correct as its description.**

### Open with what the screen is FOR

Whose job, and what they came to do. One sentence, first. **Every trade-off the
description cannot settle is decided by it** — what may be truncated, what must
stay visible, which property gives way. Omit it and the builder defaults, and a
default is never deliberate.

### Separate the product from the capture

A frame is a recording, so it carries what the software never drew: browser
chrome, a pointer, a hover tooltip, a scroll position, a private-window badge.
Name them before describing anything.

Two are dangerous. A **pointer halo** is indistinguishable from a deliberate
accent, so it gets copied and the copy looks intentional. A **scroll position**
clips a region part-way, which looks exactly like a region designed with a flat
edge — say it was scrolled, or the build ships that edge forever.

**Say whether the frame was signed in.** A supplied frame usually is, and every
personalized region in it is unbuildable from a public route.

### Write it as a tree, from the bottom up

**Atoms first, the screen last.** Attention decays along a description and the
fragile facts are at the bottom — a unit's height in lines, a radius as a
fraction of it, which of two things yields.

1. **Atoms** — indivisible marks. Described once and referred back to.
2. **Compounds** — a few atoms reading as one object. Parts in order, the gaps,
   which flexes, which gives way first.
3. **Assemblies** — arrangements and repetitions. Counts, the repeating unit,
   how many visible.
4. **The screen** — assemblies against each other, and **which single region
   scrolls**. A screen whose body scrolls and one whose panel scrolls look
   identical at rest.

Then for the whole: the **type ramp** (distinct sizes, largest first, what uses
each) · **colour** (every distinct one and the single job it does) · **which
states the frame shows and which it does not** — anything absent is a decision
the build must make.

### What to record at each node

- **Count everything that repeats.** "Several" is not a count, and a wrong one
  survives everything. Recount off the source once the build renders.
- **The repeating unit's height in lines**, and how many fit a container. Built
  two lines tall where the source was one, it holds half as much and still looks
  intentional.
- **Every text element** — role · weight against neighbours · rank in the ramp ·
  one line or wraps · how it reads when absent.
- **Every box, relationally** — radius as a fraction of its own height. What
  reads as a crisp edge on a card reads as a pill on a one-line strip.
- **Every control — its label and its options, never its position.**

### Never hedge · stay relational · cite no evidence

"Appears to", "roughly", "seems" — a hedge becomes a silent defect, because the
builder must choose and has nothing to choose by. If a detail cannot be read,
write **"cannot be determined from this frame"** and say which reading was taken
and why. That is checkable; a hedge is not.

**Every comparison names its reference, and the reference is something else in
the same description** — never a pixel, never a hex. A frame has no reliable
scale and our theme overwrites every ramp anyway. The test: could someone else
check it without you?

**A description cites no evidence** — no URL, no capture path, no vendor in the
body. Written from a frame, it stands alone, which is what makes it checkable by
someone who lacks the picture.

### Three sections this project adds

We read a frame into a screen *bound to a discovered route*, rendered *inside an
existing shell*. That is three facts a pure-UI format has no place for.

- **Data slots** — per compound, which route field fills it, named exactly, and
  which are nullable with what the screen does then. The frame supplies shape,
  the route supplies data, and the description is the only place they meet.
- **Structure versus skin** — structure transfers, skin does not. Region order,
  hierarchy, density, spacing rhythm, which states exist: take them. Hex values,
  brand fonts, wordmarks, the signature accent: leave them. One page cloned
  skin-and-all looks convincing; several in one app put that many clashing brand
  identities in adjacent tabs of one product.
- **Host context** — which shell the screen lands in and what it already
  provides. **Every captured frame is standalone; every screen we build is not,**
  and nothing in a frame can show that join. Chrome the shell already provides is
  cut, not stacked.

Then **out of scope**, resolved against the tree: for every assembly named, say
what survives. An assembly reduced to nothing is a finding about the tree, not a
footnote.

---

## Part 2 — Comparing what was built

**The rendered screen is the only evidence this loop admits.** Format, render,
then look. Put it beside the description, section by section — not beside the
frame, which by then is deleted.

Every divergence resolves to exactly one row, and a divergence filed under the
wrong row installs a rule that fixes nothing:

| What happened | Fix goes to |
|---|---|
| The description never said it | Part 1, as a new or widened instruction |
| It said it ambiguously | Part 1, that section's wording |
| It said it plainly and the build ignored it | Part 3 |
| It said it and the build could not do it | `apps/`, `packages/` |

**The test separating rows two and three:** re-read the line cold. If a competent
reader could have built the wrong thing from that text, it is a description
defect. Do this before writing the fix — the two feel identical from inside the
cycle that produced both.

### Which frame next

**Pick by missing archetype, never by rotation.** The corpus is worth having for
the SHAPES it covers, so the next frame is the one whose arrangement the
collection does not yet hold. Rotating subjects produces four subjects' versions
of one shape and calls it breadth.

**Never twice running from one subject**, and derive what is covered by reading
the existing descriptions rather than keeping a list — a maintained inventory
rots on its first addition.

---

## Part 3 — The accumulated guidance

Rules for the build. Each earned its place from two or more unrelated subjects.

### G1 — Walk the description's lists before calling anything finished

Stated counts are contracts. Stated order is a contract. A build that renders a
subset of a stated list, in a different order, looks finished.

### G2 — A route reports what it actually got, and so does the screen

Every response carries what it returned against what exists upstream. When they
disagree the screen says so in words a reader understands. **A screen that
renders N items silently is indistinguishable from a source that has N items** —
and that is the defect, not the short page. Where the route explains the
shortfall, show the explanation.

### G3 — Render no control that cannot act

A control implies an action. Where the route exposes no write, the affordance is
cut and the underlying figure survives as text. An arrow that cannot vote is
worse than no arrow.

### G4 — A stated responsive rule appears as a real breakpoint

One unconditional value satisfies the wide reading of the rule and silently
fails the narrow one — and the wide screenshot looks correct, so the defect
survives any check that stops at one viewport. Render both.

### G5 — Read the field before designing the slot, and say what the response lacks

A sample where every instance of a field is empty or null gives its name and
nothing else. Guess the element shape and the guess type-checks, because a cast
asserts rather than validates — the failure arrives at runtime, in the branch
that only fires on the populated case.

The mirror of that is worse because it looks finished: **every atom the tree
names is resolved against the response, or declared decorative in writing.** An
atom with no field behind it ships as an empty well — a blank circle where a
picture belongs, a chip with nothing in it — and reads as a styling bug rather
than as missing data. Where the response genuinely lacks it, the fix is the
route, not a placeholder: the screen is the first consumer that proves a field
was never returned.

### G6 — Absence has kinds, and they are distinct

Nothing-matched, request-failed, not-yet-loaded, and **nothing-asked-yet** are
four different facts. The last belongs to any screen whose subject is a query,
and it is the state such a screen opens in: collapsing it into empty tells a
reader their search failed before they have searched. Rendering any two of the
four identically throws away the only information the reader needed. Loading
holds the populated rhythm so the page does not reflow when data lands.

### G7 — A count that agrees with itself is not a completeness signal

A response field named for a total, whose value is the length of the array beside
it, cannot ever disagree with that array — so the screen's "showing N of M" line
is true by construction and stays green while the route silently serves one page
of thousands. Read the upstream's own total, or report that there is none. **"14
of 14" and "14, total unknown" are different claims**, and substituting the first
for the second is the defect, not a formatting choice.

### G8 — A state the upstream will not produce on demand is a state nobody looked at

Empty, refused, partial and in-flight are the states most likely to be wrong,
because a healthy upstream serves none of them when asked. Built once against a
guess and never rendered, they survive every review: the screenshot that got
looked at was populated. So the states are made reachable locally — served from
the recorded response shapes, selected through the same identifier the screen
already takes from its URL — and each one is rendered and looked at before the
screen is called finished. An in-flight fixture must actually hold, since a
stand-in that answers instantly cannot exhibit a behaviour defined by waiting.

### G9 — State the constraint at the code site; never cite the description

The description is deleted when the cycle closes and the screen is not, so a
comment reading "see §5 of the description" is a dangling reference the day it is
written — and the next reader cannot tell whether the rule still holds or was
superseded. Write what the constraint *is* and why the naive thing fails. The
build then carries its own reasons, and the description stays free to be thrown
away, which is what keeps it honest as training data rather than documentation.

---

## Artifacts

| Artifact | Where | Lifetime |
|---|---|---|
| Frame | `.snapshots/<label>/` (gitignored) | deleted once described, before the build |
| Description | beside the frame | deleted when the cycle closes |
| Built screen | `apps/web/` | discarded with the cycle |
| This file, build fixes, framework fixes | committed | permanent |

Deleting the frame before building is the gate. A solo run has already read the
image into context, so deletion stops it being re-consulted for detail but
cannot unsee the layout — a clean solo comparison proves the description is
**consistent**, not that it is **sufficient**. Sufficiency needs a fresh reader:
hand one the description alone, in a clean session, when a specific line is
suspected of being clear only to its author.

## Capture

`node scripts/snapshot.mjs --help` for frames and for rendering the build.
`node scripts/fixture-api.mjs --help` serves the recorded response shapes on
their own port, which is what makes G8 practical: point the app at it and every
state is reachable, repeatable and free of outbound requests.

A protected site serves an interstitial that screenshots perfectly, so **read the
exit code** — a challenge is a finding, not a retry. Changing engine or profile is
a rung; changing a header is a retry.

**When captures start being refused, probe the routes before climbing another
rung.** Reputation is shared between the capture browser and the domain routes,
and only the routes show the bill — a route degrading in step means further
attempts make it worse. Ask the maintainer for a frame instead.

**Frame capture is outward-facing and runs attended.** Rendering the build is
not: against the fixture it touches nothing external, which is the half of this
loop that is safe to iterate on unsupervised.
