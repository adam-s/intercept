# Handoff — the web UI, and hooking it to the domains

**Written 2026-07-29. Delete this file when the work ships.** It is a briefing
with a shelf life, not a work order and not a queue: the maintainer directs what
gets built, and anything durable that comes out of this work belongs in the file
that owns it — an agent definition in `.agents/`, a decision in
[PLANNED-WORK.md](PLANNED-WORK.md), a constraint in a code comment — never back
in here.

Read [AGENTS.md](../AGENTS.md) and [PLANNED-WORK.md](PLANNED-WORK.md) first. The
UI section of PLANNED-WORK already records what was decided about the
`ui-explore/loop` method and what not to port; this file does not repeat it.

---

## The job

Two things, and they are not the same thing:

1. **Build the UI in `apps/web` that consumes the domain routes.** A product
   deliverable. Permanent.
2. **Adopt the `ui-explore/loop` method for tuning how that UI gets built.** An
   instruction-tuning harness. Its screens are deliberately disposable.

Keeping them apart is the whole design problem — see "The split that matters".

## Verified state, 2026-07-29

Checked rather than remembered. Re-check anything here before relying on it; the
repo moves.

| Fact | Value |
|---|---|
| `apps/web` | Next.js, three pages, ~3,000 lines |
| Its stack | radix-ui, tailwind, `nuqs` for URL state, `sonner`, `next-themes` |
| Its pages | a public landing, a dashboard, a browser viewer |
| **Calls to the API** | **none — no `fetch`, no `localhost:3001` anywhere in `apps/web/src`** |
| Domains registered | boardshop, youtube, yahoofinance, reddit, hackernews, twitch |
| Ports | 3000 web, 3001 API. `pnpm dev` starts both |

**That fourth row is the actual gap.** Six domains' worth of routes exist and no
UI consumes any of them. This is the "shipped means reachable" failure AGENTS.md
describes: every part passes its tests, reads as done, and changes nothing,
because the last wiring step was left for later.

## What `/api` already gives you

The index route returns, per domain: `name`, `routeCount`, `routes` (method +
full path), `examples` (concrete, callable invocations — routes with path
params or required query params are not callable from their bare path), and
`upstream` (what each route consumes, scheme-less with `{placeholder}` for the
parts that vary).

So a route is already self-describing enough to be *invoked* from a generated
UI. What it does not yet declare is its **response shape** or any render hint.
Whether to add one is an open decision below.

## The split that matters

`ui-explore/loop` states its own premise: the instructions are the product and
the screens are training data, so a screen may be rebuilt or thrown away.
AGENTS.md names the same distinction and warns against merging the two families.

A shipping dashboard is not disposable. **Point the loop at the real UI and the
property that makes the loop work is gone** — rebuild-don't-patch is load
bearing there, and you cannot rebuild the product from scratch every iteration.

[base-branch.md](../.agents/rules/base-branch.md) pushes the same way from
another direction: domain plugins *and their dashboards* are ephemeral, and the
invariant is that deleting every test branch loses nothing of lasting value.

Both constraints resolve to one split:

| | Belongs on `main` | Disposable |
|---|---|---|
| The loop | the method, as an instruction-tuning skill | the screens it produces |
| The dashboard | generic renderers keyed by transport | per-domain pages |

## Suggested starting position — a recommendation, not a decision

Recorded so it can be argued with rather than rediscovered. None of this is
settled; the maintainer decides.

**Generate from the domain index rather than hand-writing a page per domain.**
The six domains serve genuinely different shapes — a paginated listing, an SSE
stream, a WebSocket carrying frames, a media manifest, a search result, an
elimination table — but that set is small and closed, and it is the *transport*
that decides how something renders, not the site. A renderer per transport, keyed
off the route's declared transport, is reusable; a page per domain is six copies
of the same work. AGENTS.md: the first consumer is an instance, never the
definition.

**Build a thin real screen before tuning anything.** The loop picks its next
frame by missing archetype rather than by rotation, so it needs a corpus of
archetypes to aim at. Ours already exists — the transport list — but until
something renders, tuning produces guidance about screens nobody has seen.

**Do not import the loop's accumulated rules wholesale.** That document was
tuned against generic product screens: appointments, inspections, customer
records, settings panels. Our distribution is traffic manifests, live streams,
and media players. Importing guidance tuned on a different distribution
installs specifics dressed as rules, which is the failure its own Part 0 warns
about. Port the method; let the rules re-derive, or prune them hard against the
first three real screens.

## Open decisions that need the maintainer

- **Storybook.** `ui-explore` carries `.storybook`, ~57 stories, and a `.shots`
  directory; `apps/web` carries none of it. That is a real weight increase and
  AGENTS.md says the heavier choice needs a hard constraint behind it. The
  existing `dashboard-agent` already has a screenshot flow, so the question is
  whether that covers it.
- **Does the method survive the substitution?** Already flagged in
  PLANNED-WORK: the loop reads a *frame* into a description, and here there is
  no frame — the source is a route's response shape. Test that on one page
  before committing to the port.
- **Should a route declare a render hint?** It already declares `transport`,
  `examples` and `upstream`. A shape or hint would let the UI be almost entirely
  generic. It also adds a field every future domain must fill in correctly, and
  a field that is wrong is worse than one that is absent.

## Boundaries — work in flight

Domain discovery passes are running in parallel. To stay out of their way, this
work should touch **only `apps/web`** plus, if a render hint is agreed, the
route type in `packages/shared`.

Do not edit: `domains/**`, `packages/browser/**`, `scripts/route-spec.mjs`,
`scripts/discover-probe.mjs`, `.agents/rules/discovery.md`,
`.agents/agents/discovery-agent.md`.

## Landmines

- **`scripts/route-spec.mjs` reports green over routes it never called.** Its
  `covered` set strips the HTTP method before matching, so a `GET` example marks
  a same-stem `POST` route covered, the route drops out of `skipped`, and the
  "N route(s) not probed" line never prints. Any "N routes passed" number
  predating the fix is suspect. Being fixed on the domain side — do not fix it
  here, and do not trust route counts until it lands.
- **`apps/web/src/lib/url-state.ts` has a pre-existing lint failure.** Several
  worktrees have each fixed it independently. Fix it once on `main`.
- **A green suite proves less than it looks.** Everything in this repo is
  expected to prove a new check goes red before it goes green. A UI test that
  has never failed is a claim, not a check.

## Starting commands

```bash
pnpm dev                        # API on 3001, web on 3000
curl -s localhost:3001/api      # the domain index the UI should render from
pnpm biome check . && pnpm turbo typecheck && pnpm turbo build && pnpm vitest run
```

The reference material for what the routes actually return is
`domains/boardshop` — it carries a working route per transport, and its
`ROUTES.md` indexes them by pattern.
