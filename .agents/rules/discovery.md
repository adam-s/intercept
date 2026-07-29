---
description: The five-step discovery protocol and its gates — breadth first, elimination before any route code
paths:
  - "domains/**"
  - "packages/browser/**"
  - "scripts/discover-probe.mjs"
---

# Discovery Protocol

Navigate a page → trigger pagination → capture the request/response → build a
proxy route.

> **GATE: the transport elimination table is filled BEFORE any route code.**
>
> **Explore breadth. Discover every transport before building any route. Never
> target a named endpoint — let the protocol find them.** Naming a specific
> route up front produces tunnel vision and misses the transports that only
> appear under interaction.

Five steps, no skipping: **PRE-FLIGHT → GATHER → SCAN → CLASSIFY → BUILD.**

> **GATE: a documented public API is not a discovery result.** "Discover the API
> for X" means intercepting the traffic X's own front end makes — not finding X's
> published developer API and wrapping it. Searching for public API docs as a
> first step skips the entire point, and it looks like success: you get working
> routes and zero knowledge of the site's real transports.
>
> A public API is in scope only when the maintainer explicitly asks for it, or
> when interception is complete and its endpoints turned out to need credentials
> no browser session can supply. Sites with famous public APIs are where this
> shortcut is most tempting and most costly.

The mechanical parts of GATHER and SCAN are a script, not a recipe:
`node scripts/discover-probe.mjs --help`. Its header docblock states what each
mode does and the bounds it respects. Read that rather than assembling requests
by hand — a hand-built probe that silently returns nothing reads exactly like a
site with no API.

---

## STEP 0: PRE-FLIGHT (no tool calls — use what you already know)

You have been trained on the web. Write down what you already know about the
target before connecting anything.

```text
## Pre-flight: [target URL]
- What is this site? What does it sell or show?
- Framework: [Next.js, SvelteKit, React SPA, server-rendered, ...]
- Known API patterns: [internal API paths, GraphQL endpoint, REST]
- Pagination: [cursor, offset/limit, page numbers, infinite scroll, "Show More"]
- Authentication: [public, API key, CSRF token, cookies, OAuth]
- Bot protection: [Cloudflare, Kasada, Akamai, DataDome, none known]
- Embedded data: [__NEXT_DATA__, data-sveltekit-fetched, __NUXT_DATA__, ...]
- Real-time transports: [WebSocket, SSE, HLS/DASH, PubSub — and which page types carry them]
- Known gotchas: [geo-restrictions, consent walls, login walls]
```

**Real-time transports need the right page.** Breadth-first discovery misses
them because they only exist on chat pages, live feeds, dashboards, or video
players. Name those page types now, and navigate to them during GATHER.

**Content hierarchy.** Every site drills down to a paginated list. Write yours
out and name the specific busy instance you will navigate to — not "a popular
category" but the actual path you will take to reach 100+ items.

```text
Level 1: [top-level browsing]     → the busiest category
Level 2: [mid-level listing]      → the most popular item
Level 3: [detail with sub-items]  → pagination lives HERE
```

Common shapes: genre → artist → event → **ticket listings**; brand → category →
**product listings**; channel → video → **comments**; league → team → **games**;
topic → thread → **replies**; query → **results**.

**Pre-flight is hypothesis, not fact.** Training data goes stale. GATHER
confirms or corrects every line, and no route is built on pre-flight alone.

---

## Two passes: instrumented, then clean

**Everything that helps discovery is detectable, so nothing that helps discovery
runs during the pass that has to succeed.** Patched primitives, a synthetic
interaction sweep, rapid probing — each is a signal, and a hardened site reads
signals. Run them and the observation becomes a cause of the outcome.

So the work splits in two, and the split is not optional on any target with bot
protection:

| | Instrumented pass | Clean pass |
|---|---|---|
| Purpose | learn what transports exist | collect the data |
| Aids | instrument, interaction sweep, probing | none |
| Profile | disposable | the one you intend to keep |
| Output | the manifest and the elimination table | route responses |
| If it is blocked | says nothing about the site | a real finding |

The instrumented pass answers *what is here*. The clean pass uses that answer
and carries no aids at all — the instrument is removed, the sweep does not run,
and requests go at a human rate. A session that keeps its patches carries a
permanent tell; one that restores them is an ordinary tab again.

**A block during an instrumented pass is not evidence about the site.** It is
evidence about the pass. Recording "this site blocks us" from an instrumented
run attributes to the target what may have been caused by the observation, and
that wrong finding then shapes every later attempt. Re-test clean before
recording any conclusion about bot protection — and if the clean pass succeeds
where the instrumented one failed, the finding is about our own footprint.

**Suppress aids one at a time when a run starts failing.** Several things are
detectable at once, so removing all of them tells you only that the set was the
problem. Drop the sweep first — synthetic interaction has no human trajectory
and is the loudest — then the instrument, then the probing rate. The first
suppression that restores success names the cause, and that is a finding worth
writing down rather than a workaround to leave in place.

**Budget the instrumented pass.** It is the expensive, conspicuous half: it
navigates more, clicks more, and asks for more than a reader would. Saturation
applies to transports, not to pages, so stop when a pass adds no new transport
rather than when the site runs out of pages.

---

## STEP 1: GATHER

Two jobs: confirm the pre-flight, and intercept pagination.

**Connect to the homepage first, never a deep link.** Browse naturally — scroll,
follow a link or two, then navigate to the target page. This establishes cookies
and avoids the bot walls that direct deep-link navigation trips. The connect
command is in [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

**Find a page with 100+ items.** Check the count before attempting interception:
read a "showing X of Y" indicator, or count list elements. Below ~30 items,
navigate to a busier instance instead — pagination controls and XHR endpoints
only appear when there is enough to paginate.

**Intercept pagination** with `--mode=paginate`. It snapshots traffic, triggers
the page's own pagination control, waits, and reports what appeared. Repeat two
or three times to confirm the pattern. You are capturing the *pattern*, not
downloading the data: once you have the URL, method, headers, and pagination
mechanism, stop.

**When pagination parameters are already visible in traffic**, don't wait for a
click to produce new entries. Probe the next page directly with `--mode=probe`.
Different items back means a confirmed paginated API — record it and move on.

**Zero new entries does not mean no XHR API.** The data may have been prefetched
with the first call, a service worker may have served it, or the request may
have been deduplicated. Before concluding embedded/SSR: scan for any endpoint
carrying pagination parameters and probe it directly. Conclude "no XHR" only
after that comes back empty across several pages.

**GATHER is done when a pass finds nothing new — never when you have "enough".**

Run GATHER at least **twice** over the same site, and keep going until a full
pass surfaces no transport and no endpoint the previous pass missed. A second
pass reliably finds more than the first: streaming and interaction-only
transports need page types the first pass had no reason to visit, so "I found a
paginated endpoint" is a statement about what you looked at, not about what the
site has.

Record the count of *new* findings per pass. A pass that adds nothing is the
stop signal; a pass that adds something means run another. That delta is the
only evidence available that the inventory is complete, so write it into the
elimination table rather than discarding it.

**Saturate on transports, not on endpoints.** These are different targets and
conflating them either stops you early or never lets you stop. A large site has
hundreds of minor endpoints and enumerating them all is not the job; the
elimination table is a claim about *transport classes*, and that set is small
and genuinely saturable. So: keep passing until a pass reveals no new
transport. Endpoint discovery rides along, and where it is deliberately partial,
say so — "transport classification complete; endpoint inventory partial" is an
honest result. "Complete" without that qualifier is a claim about both.

**Rules that bind the whole step:**

- Browser only. No direct HTTP, no fetching HTML or JS outside the browser —
  that belongs in SCAN.
- Page interaction and endpoint probing both go through the browser, so they
  carry the session. Reading embedded state out of the DOM belongs in SCAN.
- Cross-origin probes must forward cookies, or a session-gated API answers with
  a challenge page.
- Low traffic after one page load is normal. Navigate more pages rather than
  concluding the site is empty.
- **Traffic resets on navigation.** Capture before navigating away; re-capture
  after the new page settles.
- **WebSocket traffic is not captured** by the traffic interceptor, which
  records HTTP only. Detect WebSocket by scanning script bundles for its markers
  (`--mode=bundles`), then confirm the URL directly.
- If the browser connection drops, reconnect once. If that fails, continue with
  what you have and say so — a give-up is a reported outcome.
- **A rate limit you caused is not a property of the target.** Probing hammers
  one host from one address with one user agent, which is exactly the shape
  abuse counters watch for. Before concluding an endpoint is session-gated,
  rule out the counter you tripped yourself: vary the user agent, pause, and
  retry once from a different shape. A 429 that clears under a fresh user agent
  is your own footprint, and building a browser-only route around it adds cost
  and fragility the endpoint never required.

---

## STEP 2: SCAN

Now analyze everything.

**Traffic scan** — `--mode=scan` groups every captured endpoint and ranks the
ones carrying pagination parameters first.

**Probe what it surfaces.** Any endpoint with a pagination parameter gets tested
immediately with `--mode=probe`. Data back means the transport is confirmed —
mark it in the elimination table now, with the output as evidence.

**Embedded data.** Fetch the HTML of two page types and look for the framework's
state container, JSON script blocks, hidden inputs, and meta tags.

**Source scan** — `--mode=sources` is the check that keeps a ✗ honest. It scans
every captured document and script against the transport signature table and
reports, per transport, whether the evidence is *strong* (the API itself, like
`new WebSocket(`), *library* (a dependency that implies it), or *wire* (a
content type).

**A strong hit against a row you want to mark ✗ is a contradiction.** The mark
is a judgment; the signature is a fact about the code. Probe that transport
properly before writing the verdict — twice on one target, agents checked three
framework names, missed a fourth, and recorded a present transport as absent.

It also lists API-shaped paths found in source. **Any path in source that never
appears in captured traffic is interaction-gated** — it exists, and passive
browsing structurally cannot reach it. Those are the endpoints to go drive the
page for, and they are where a second pass earns its cost.

**GraphQL.** If traffic, HTML, or a bundle shows a GraphQL endpoint, introspect
it with `--mode=graphql`: one call lists every root query, which is the whole
API surface at once.

**Method dispatch.** Some sites route every action through one URL with a
`method` parameter. POSTs to page URLs that return JSON are the tell. These
always need the browser's session.

**Access gap table.** One request per endpoint — a rate-limit or challenge
response *is* the answer, not a prompt to retry.

```text
| Endpoint | Through the browser | Direct HTTP | Gap? |
|----------|---------------------|-------------|------|
| [url]    | 200                 | 200/401/403 | Y/N  |
```

Gap=Y means the endpoint needs a harvested session. Read the session-harvest
reference in the api-discovery skill before building it, and register the host
as session-gated so the transport-tier guard enforces it — see
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

---

## STEP 3: CLASSIFY (reasoning only)

**Classify per data type, not per site.** One page routinely serves different
data over different transports — a listing over XHR, its prices over a
WebSocket, its metadata server-rendered into the HTML. A single table for the
whole site invites the failure it is meant to prevent: you confirm XHR for the
first data type you find, mark JSON API present, and stop looking, while another
transport on the same page goes unrecorded.

So name the data types first — the things a consumer would actually ask for —
and carry a row set for each. A transport is only ✗ for a data type once you
have probed for it there.

**Every row is demonstrated in the reference material — read it before
verdicting one.** The reference domain carries a working route per transport,
each declaring which one it consumes, and the test server carries a fixture that
serves it. A row you have never seen present is a row you cannot honestly mark
absent, and the two together are the cheapest way to learn what it looks like
when it is there: what fires, what the payload is, how a route consumes it. A
repo test holds the correspondence, so a row in this table always has material
behind it.

Four of them are worth reading before any live run, because each is a verdict a
JSON-shaped scan gets wrong by default: data held in HTML *attributes* rather
than a JSON blob, a long-poll that is indistinguishable from a slow GET, an
`EventSource` that looks like a plain GET at the wire, and work done in a scope
the page cannot see — a worker, a service worker, an iframe answering over
postMessage.

**Do not write this table from memory — derive it.** The capture layer patches
every browser egress primitive and reduces what it saw into the table directly,
so each ✓ carries the call shape that produced it. Reasoning about traffic
cannot tell an `EventSource` from a long-poll `fetch`, cannot see a JSONP call
that the wire files under "script", and cannot recall a socket that opened
during a burst of two hundred requests. Derived, present/absent is a fact with
an event behind it, and your job narrows to explaining rows and closing the ones
that read absent.

Paste the derived table, then add per data type:

- a `Pass` column recording which pass first found each ✓, with the per-pass
  new-finding count beneath the table, and
- for every ✗, a line saying what you did to make it fire.

**A derived ✗ means "not observed", which is weaker than "the site does not have
it".** A transport that only opens behind an interaction is absent from a
capture of a page that was merely loaded — which is why the interaction sweep
exists and why a ✗ recorded before the sweep ran is not yet a finding. Upgrade a
✗ to a claim about the site only by saying what you provoked and where: "no
socket after the sweep, and no page type on this site mounts a live surface"
is falsifiable; "WebSocket ✗" is a conclusion indistinguishable from not having
looked.

Two ways a row misleads even when the mechanism worked, both worth checking:

- **The primitive is right and the payload is the story.** One WebSocket row
  can be a JSON feed, a text protocol tunnelled through it, or an encrypted
  envelope. Read a frame before you decide what the row means.
- **Elimination can be correct and still hide a transport.** A site with no
  WebSocket may still stream — over long-poll, over SSE, over repeated fetches
  on a timer. A ✗ closes one row; it never closes the question the row was
  standing in for.

Every Gap=Y endpoint has a planned route. **BUILD does not start until this
table is complete.**

---

## STEP 4: BUILD

One route per confirmed transport. The reference domain has working code for
each; its ROUTES.md indexes them by pattern.

**Write every file before restarting the server.** The server does not reload
domain files — the full sequence is in
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md). When a route needs a fix:
edit, stop the server, start it. Do not investigate why old code is running.

**The route-building ladder, in order:**

1. **Browser fetch first.** It already holds the session, so if it returns data
   you have a working request.
2. **Eliminate.** Remove headers and cookies one at a time until you have the
   minimum required set. This is what makes the rest of the ladder legitimate.
3. **Store the minimum** in the session manager, which persists it and handles
   expiry.
4. **Write the handler** against that stored minimum.
5. **Verify without the browser, last.** If the endpoint turns out to need the
   browser after all, register the host as session-gated so the next caller
   fails at the call site instead of parsing a challenge page.

**Reading page globals needs the main-world bridge.** The browser's `evaluate`
runs in an isolated world that shares the DOM but not JavaScript globals, so
reading `window.__INITIAL_STATE__` or a widget API directly returns `undefined`
with no error thrown. Use the bridge — see
[packages/browser/src/shared/main-world.ts](../../packages/browser/src/shared/main-world.ts).

**Every route reports what it actually got.** Item count against indicated
total, and an explicit incomplete signal when they disagree. The framework's
completeness helper derives this; a route that passes an upstream body straight
through runs it through that helper.

**Every route declares `examples`** — concrete invocations relative to the domain
mount, like `['/chart/MSFT?range=5d']`. A route with a path parameter or a
required query parameter cannot be called from its declaration alone, so without
an example the checker skips it, and a skipped route reads exactly like a
passing one. Use real identifiers: an example naming an id the site does not
have fails the route for a reason that has nothing to do with the route.

**Every route declares `upstream`** — the endpoints it consumes, written
scheme-less with `{placeholder}` for the parts that vary:
`['www.reddit.com/r/{sub}.json']`, `['gql.twitch.tv/gql']`. A route's own path
says nothing about what it calls, and the coverage check cannot recover that by
name similarity — the names genuinely have nothing in common. Without it, real
coverage reads as zero and a genuine gap hides in the false alarms.

**Check recall before declaring done** — `--mode=coverage` diffs the endpoints
the browser actually called against the routes you built, and prints a floor.
Every unaccounted endpoint fired in a real browser, so every one exists: build a
route for it, or write in the elimination table why not. Matching is weak by
design, so "unaccounted" means unexplained rather than certainly missed — but an
unexplained endpoint is not a finished discovery.

Treat the number as a floor. Interaction-gated endpoints never fire under
passive browsing, so the real surface is always larger than it says.

**Test each route before building the next**, then assert the whole set with
`node scripts/route-spec.mjs`. Its "not probed" line is a coverage report, not a
footnote — a domain whose routes are mostly unprobed has mostly not been
checked.
