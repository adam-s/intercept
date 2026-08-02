# Twitch Routes — Quick Reference

Read `src/routes.ts` for the full route index; each route carries an inline
comment with the discovery finding that shaped it.

## By Pattern

**GraphQL, single-page listing (100-item server cap):** Route 1 — directory
listing, `DirectoryPage_Game` persisted query
**GraphQL, single-page listing:** Route 2 — channel VOD listing,
`FilterableVideoTower_Videos` persisted query
**HLS media (token → master playlist → variants):** Route 3 — live stream,
fully replayable via plain HTTP, no browser
**WebSocket (anonymous IRC-over-WS, text protocol):** Route 4 — chat tail,
`justinfan*` login, no auth
**JSONP:** Route 5 — Eppo feature-flag config, strip the callback wrapper

## Session-gated / not built

- Cursor pagination past page 1 of Route 1 and Route 2's listings: gated by a
  Kasada `client-integrity` token minted by obfuscated in-page JS. Confirmed
  failing even for the live, cookied browser's own organic request — see the
  comment above Route 1. Reported as a give-up, not built.
- `hermes.twitch.tv` WebSocket (PubSub): present, but its frames are an
  encrypted PKCS7-shaped envelope with no documented client-side decryption —
  read per the "a socket's frames are the finding" rule, not built.
- `api.twitch.tv/helix/*`: the front end calls this too, but it requires an
  OAuth bearer token this session never captured (`401 OAuth token is
  missing` on a bare Client-ID request). GraphQL already exposes equivalent
  data with no token, so this was not pursued further.
- Cross-frame RPC (`postMessage`): an ad/Prime-extension iframe, not Twitch's
  own product data.

## Coverage: every unaccounted endpoint, named

`discover-probe --mode=coverage` reported a 35% floor with 17 unaccounted call
shapes from a passive-browsing sample. Accounted for here rather than left as
noise:

- `gql.twitch.tv/integrity` — the Kasada token mint itself; see the give-up
  above. Not a route target, it's the gate that blocks one.
- `{node}.playlist.ttvnw.net/v1/playlist/{id}.m3u8` — the variant playlists
  Route 3 (`/stream/:login/hls`) returns URLs for. Route 3 now also fetches
  the cheapest variant itself and reports the resulting status plus the first
  segment URL, so the chain is verified inside the route, not just described.
- `*.cloudfront.hls.ttvnw.net/v1/segment/*.ts`, `*/probe` — the actual video
  segment bytes and the Amazon IVS player's latency probe. Verified reachable
  by hand during discovery (`curl` returned 200 for a real segment); not
  fetched by the route itself; downloading video bytes into a JSON API
  response is out of scope for what this route promises.
- `assets.twitch.tv/assets/amazon-ivs-wasmworker*.wasm` — the in-browser IVS
  player's WASM decoder. Redundant with Route 3, which bypasses it entirely
  by fetching playlists/segments directly instead of decoding client-side.
- `assets.twitch.tv/config/manifest.json`, `k.twitchcdn.net/*/fp`,
  `k.twitchcdn.net/*/tl`, `k.twitchcdn.net/*/ips.js`, `spade.twitch.tv/track`,
  `reporting.cdndex.io/error` — client config, Kasada fingerprinting/
  telemetry, and analytics beacons. None carry product data a consumer of
  this API would ask for.
- `s.amazon-adsystem.com/iu3`, `/iui3`, `www.twitch.tv/` (the document itself)
  — third-party ad iframe traffic and the SSR shell. The shell carries no
  exploitable embedded state (see the Cross-frame RPC/HTML-over-the-wire rows
  in the elimination table); the ad iframe is not Twitch's own data.

## Key Files

- `routes.ts` — All 5 routes with inline discovery-finding comments
- `config.ts` — InterceptorConfig; every route is `browserRequired: false`
- `interceptor.ts` — Extends GenericInterceptor with nothing to harvest
- `index.ts` — Plugin entry point (DomainPlugin export)
