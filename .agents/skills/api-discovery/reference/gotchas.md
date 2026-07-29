# Gotchas

## Single browser singleton

One browser instance, module-level singleton. New WebSocket profile connection destroys the existing browser. Multiple pages within the same context are fine (`page.context().newPage()`), but only one profile at a time. Traffic capture is profile-scoped.

## Common problems and fixes

| Problem | Fix |
|---------|-----|
| Traffic shows 0 entries | Verify WS-connected browser (auto-start has no capture). Wait 15s. Follow the pipeline in `discovery.md`. |
| 429 on API endpoint | Don't retry with curl. Use `browserFetch` (it has cookies). Then run elimination to find minimum auth set. |
| 202 WAF challenge | WAF blocks direct HTTP. Use `browserFetch` — it has the browser session. Then eliminate to find required cookies. |
| Token endpoint returns 429 | Token is almost always in the page HTML, cookies, or JS globals. Don't call dedicated token endpoints. |
| Body text empty after navigate | Stubborn page — check for captcha iframe |
| `browserFetch` loses session cookies | Use `navigateTo` for CORS subdomains |
| Direct fetch 429 but browser 200 | TLS fingerprinting — use `browserFetch()` |
| Persistent 429, curl returns 200 | Poisoned profile — wipe and recreate (see rate-limits.md) |
| Script tags missing from DOM | Framework hydration stripped them. Fetch raw HTML with `rateLimitedFetch` instead of `page.evaluate(document.outerHTML)`. See Route 20 in boardshop. |
| Route 404 after editing routes.ts | Kill port 3001, rerun `pnpm dev` |
| `page.evaluate` throws `__name is not defined` | tsx/esbuild injects `__name` — use string-based evaluate |
| Multi-domain needs both sites' data | `page.context().newPage()` — pages share cookies, faster than re-navigating |

## Caching and polling

For rate-limited data sources, cache responses with a TTL. See Route 12 (crumb-example) in boardshop for a working 5-minute cache pattern.

For background polling, use an in-memory Map with TTL expiration. Route handlers read from the cache; a background interval refreshes it.

## Complex text parsing

If extraction requires more than ~3 lines of regex, use the Python bridge (`services/python/worker.py`) with NLP libraries (`dateutil`, `usaddress`, `thefuzz`, `spacy`).

## Verify with diverse inputs

Test every route with at least 3 different entities before declaring it complete.
