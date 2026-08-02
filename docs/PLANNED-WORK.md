# Planned work

Decisions already made, not yet built. Each entry says what was decided and why,
so the next session starts from the decision rather than re-litigating it.
Delete an entry when it ships.

## Tuning iterations — next

Run the instruction-tuning skills **one or two iterations at a time**, not in a
long unattended sweep. The maintainer reads each result before the next starts.

The two tuning skills test different things and stay separate:
`instruction-tuning` measures whether a sub-agent follows the discovery
protocol; `instruction-dashboard-tuning` measures whether a written description
of a real screen is sufficient to build from. Both produce throwaway artifacts —
the instruction and framework fixes are the product. The skill itself records
why the seam exists, so neither gets merged into the other later.

Two changes from this session that the next tuning run should exercise, because
both altered what an agent is told to do:

- `.agents/rules/discovery.md` no longer carries literal request recipes; it
  points at `scripts/discover-probe.mjs`. A tuning run shows whether an agent
  reaches for the script or improvises requests anyway.
- AGENTS.md is principles-only. A tuning run shows whether an agent still finds
  the facts it needs in `docs/` and the script docblocks.

## The product UI is still unbuilt

`apps/web` has three pages and makes no call to `/api` — six domains' worth of
routes exist and nothing consumes them. This is the "shipped means reachable"
gap AGENTS.md names: every part passes its tests, reads as done, and changes
nothing.

It stays open deliberately. The dashboard-building instructions are being tuned
first, by `instruction-dashboard-tuning`, so the product UI gets built by
instructions that have already been corrected against real screens rather than
becoming the thing we correct them on. A shipping dashboard cannot be the
tuning loop's subject — rebuild-don't-patch is load-bearing to the loop and
cannot be applied to a permanent page.

Open when it is built: whether a route should declare a render hint alongside
`transport`, `examples`, and `upstream`. Decided for now as no — the UI keys off
`transport` and adapts to what a response actually contains, because a field
every future domain must fill in correctly is worse absent than wrong. Revisit
only if the description format's data-slot section keeps straining against it.

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

## Worker scope: read, not instrumented — and why the obvious fix is wrong

A worker has its own globals, so a page-side patch never sees its requests. That
is not a corner case: a finance site's entire price feed and a video site's media
fetching both live in one, invisible to every instrumented pass until someone
read the worker's source.

Instrumenting the worker directly was tried. Patch the `Worker` constructor to
load a blob that installs the instrument and then pulls the real script in with
`importScripts`. It runs — and it breaks the worker. A blob URL has no
meaningful base, so every relative request the worker makes resolves against the
blob and fails; the benchmark's worker stopped fetching entirely. Reverted, and
pinned, because an aid that breaks what it observes is not a trade this
instrument may make.

The workable version keeps the worker's real URL and rewrites its response body
on the way in, which means request routing rather than a page-side patch: route
the request whose URL was passed to `new Worker(...)`, fetch it, prepend the
instrument, fulfil. The ordering is the awkward part — the route has to be
registered before the constructor fires — so it belongs in the driver rather
than in the injected source.

Until then the gap is covered by reading rather than capturing: the manifest
fetches each worker script and reports the transports and hosts in its source.
That is how a live run found a socket no capture could see, and it is honest
about what it is — a transport named there fired somewhere nothing observed.

