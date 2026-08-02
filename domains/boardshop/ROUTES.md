# Boardshop Routes — Quick Reference

Read routes.ts lines 1-130 for the full route index and real-world analogue guide.

## By Pattern (what you need → which route to read)

**Public JSON API (no auth):** Route 5 (line ~240) — `rateLimitedFetch` with API key header
**Cursor pagination:** Route 4 (line ~200) — string cursors, Route 18 (line ~710) — base64 cursors
**POST pagination with CSRF:** Route 7 (line ~300) — POST body with session + CSRF tokens
**Embedded JSON (__NEXT_DATA__):** Route 15 (line ~620) — Redux state extraction
**Embedded JSON (data-deferred-state):** Route 16 (line ~660) — deep nested extraction
**GraphQL:** Route 8 (line ~350) — inline query with Client-ID auth
**Session harvest (cookies + API keys):** Route 32 (line ~1335) — seed page → harvest → paginated API
**Click-intercept pagination:** Route 33 (line ~1460) — Patchright clicks "Show More", captures POST responses
**WAF + POST pagination:** Route 31 (line ~1260) — multi-cookie session harvest
**HLS media:** Route 9 (line ~380) — token → master playlist → variants
**WebSocket JSON:** Route 13 (line ~480) — capture N frames
**WebSocket protobuf:** Route 14 (line ~530) — base64-wrapped binary frames
**RSS/XML:** Route 27 (line ~1050) — parse with cheerio
**SSR HTML table:** Route 28 (line ~1090) — parse tables with cheerio
**JSONP:** Route 22 (line ~870) — strip callback wrapper
**Captcha-gated (Turnstile-shape):** Route 34 — mint `0.<b64url>` token via in-page widget, replay to verify endpoint
**Captcha-gated (hCaptcha-shape):** Route 35 — capture `P1_<b64url>.<b64url>.<b64url>` token via postMessage, replay in `x-captcha-token` header

## Key Files

- `routes.ts` — All 35 routes with inline comments
- `session-manager.ts` — GenericSessionManager wrapper (disk-persisted sessions)
- `config.ts` — InterceptorConfig with headerSchema
- `interceptor.ts` — Extends GenericInterceptor
- `index.ts` — Plugin entry point (DomainPlugin export)
