# Hacker News Routes — Quick Reference

Read `src/routes.ts` lines 1-60 for the full discovery summary (elimination
result, access-gap table, and the session-gated transports found but not
built).

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

## Key Files

- `src/routes.ts` — All 6 routes, with the discovery summary at the top
- `src/parse.ts` — Shared cheerio parsers: story rows, comment rows/tree, cursor extraction
- `src/config.ts` — InterceptorConfig (no required headers — public, unauthenticated surface)
- `src/interceptor.ts` — Minimal GenericInterceptor subclass (no header capture needed)
- `src/index.ts` — Plugin entry point (DomainPlugin export)
