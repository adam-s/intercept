# Hacker News Routes — Quick Reference

Read `src/routes.ts` lines 1-90 for the full discovery summary (elimination
result, access-gap table, and the session-gated transports found but not
built).

## Transports this domain consumes

| Transport | Where | Route |
|---|---|---|
| HTML-over-the-wire, `?p=N` | news.ycombinator.com | 1, 7 |
| HTML-over-the-wire, `?next=<id>&n=<rank>` | news.ycombinator.com | 1, 4, 5 |
| HTML-over-the-wire, whole thread in one document | news.ycombinator.com | 2 |
| RSS/XML | news.ycombinator.com/rss | 6 |
| JSON API (XHR) | `{appid}-dsn.algolia.net` | 8 |
| SSE — **derived, see below** | nowhere: nothing upstream streams | 9 |

## By Pattern

**Story listings, ?p=N pagination (front page, best, show, ask, active):**
Route 1 (`GET /list/:type`) — `type=top|best|show|ask|active`, `?page=N`

**Story listings, cursor pagination (newest):**
Route 1 (`GET /list/:type`) — `type=new`, `?next=<id>&n=<rank>`

**Item + full nested comment tree:** Route 2 (`GET /item/:id`)

**User profile:** Route 3 (`GET /user/:id`)

**User's submitted stories (cursor-paginated):** Route 4 (`GET /user/:id/submitted`)

**User's comment history (cursor-paginated, flat):** Route 5 (`GET /user/:id/comments`)

**RSS/XML feed:** Route 6 (`GET /rss`)

**Date-addressed listing:** Route 7 (`GET /front`) — `?day=YYYY-MM-DD`, then
`?page=N` within that day

**Runtime credential harvest for a third-party search index:** Route 8
(`GET /search`) with `src/algolia.ts`

**Derived stream over a site that has none:** Route 9 (`GET /stream/new`) with
`packages/shared/src/derived-stream.ts`

## Route 9 is a derived stream, not an intercepted one

Hacker News publishes no realtime transport. The elimination table for
news.ycombinator.com records **SSE ✗ and WebSocket ✗**, and Route 9 is not
evidence against either row — it does not weaken them, qualify them, or make
this a site that streams. HN answers one request with one whole page, exactly
as it always has.

What Route 9 does is ask for that page on a timer and emit what changed. The
liveness is ours. Read it as an example of *providing* a stream over a source
that has none, and keep it distinct from the two routes elsewhere in this repo
that consume a stream the upstream really publishes:

| Route | Upstream has a stream? | What it does |
|---|---|---|
| `boardshop` SSE route | yes — an SSE endpoint | consumes it |
| `yahoofinance` `/stream/subscribe` | yes — a WebSocket | bridges it to SSE |
| `hackernews` `/stream/new` | **no** | polls a page, diffs, emits |

The reusable half — the poll loop, the diff by intrinsic identity, the
heartbeat, the disconnect handling, the bounds, and the stop-on-429 — lives in
`packages/shared/src/derived-stream.ts` and belongs to no domain. This domain
supplies only how to fetch one page (`GET /newest`) and what an item's identity
is (the story id off `tr.athing[id]`, never its rank: the list reorders between
polls, and a positional key would report a shuffle as a flood of arrivals while
missing the real one).

Events on the wire: `open` (names the upstream, says `derived: true`),
`baseline` (what was already there when you connected — deliberately not
emitted as arrivals), `item` (one per genuine arrival), `heartbeat`, `error`,
`end`. Silence is always distinguishable from death.

## Rate limiting

`news.ycombinator.com` is registered at 8 requests/minute, one connection, and
**no retry on 429** — see the comment in `apps/api/src/register-domains.ts` for
the measurement behind those numbers. HN runs on one small server. A limit this
side causes is not a property of the site, and re-sending into one is the
fastest way to record a wrong fact about it.

## Key Files

- `src/routes.ts` — All 9 routes, with the discovery summary at the top
- `src/parse.ts` — Shared cheerio parsers: story rows, comment rows/tree, cursor extraction
- `src/algolia.ts` — Route 8's runtime credential harvest, and why it leaves the browser
- `src/config.ts` — InterceptorConfig (no required headers — public, unauthenticated surface)
- `src/interceptor.ts` — Minimal GenericInterceptor subclass (no header capture needed)
- `src/index.ts` — Plugin entry point (DomainPlugin export)
