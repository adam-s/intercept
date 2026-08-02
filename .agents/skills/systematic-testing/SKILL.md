---
name: systematic-testing
description: Bottom-up systematic validation for multi-layer architectures. Use when testing domain plugins, proxy routes, API endpoints, browser connections, traffic capture, codegen output, or dashboard UI. Test each layer independently before testing integration.
---

# Systematic Validation

When testing or debugging a multi-layer system, work bottom-up. Never test a higher layer until the layer below it is verified. This approach isolates failures to the specific layer where they occur.

## The Four Layers

| Layer | Name | Key Files | Validation |
|-------|------|-----------|------------|
| L1 | Domain Plugin | `domains/<name>/src/routes.ts` | Routes registered, handler logic correct |
| L2 | API Proxy | `apps/api/src/register-domains.ts` + `packages/browser/src/handler/api-proxy.ts` | Endpoint responds, browser dispatches correctly |
| L3 | Browser + Traffic Capture | `packages/browser/src/handler/index.ts` | Browser connected, navigation works, CDP traffic captured |
| L4 | Dashboard UI | `apps/web/src/app/(dashboard)/` | Data renders, interactions work, states handled |

Dependency chain: **L1 → L2 → L3 → L4**

---

## Per-Layer Validation

### L1 — Domain Plugin

Verify the route handler logic is correct before the browser is involved.

```bash
# List all registered domains and their routes
curl -s http://localhost:3001/api | jq '.domains'

# Verify a specific route exists
curl -s http://localhost:3001/api | jq '.domains[] | select(.name == "<domain>")'
```

**Common L1 failures:**
- `handler` function not exported from `routes.ts`
- `DomainRoute` type mismatch (missing `handler` or `targetUrl`)
- Route path typo (e.g., `/search` vs `/searches`)

---

### L2 — API Proxy

Browser must be connected before proxy routes work. Note: the Access Gap table (browser vs direct HTTP status per endpoint) is generated during discovery Step 2e — this layer uses those results but does not regenerate them.

```bash
# Check browser health
curl -s http://localhost:3001/browser/health | jq '.browser'

# Call a domain route directly
curl -s "http://localhost:3001/api/<domain>/<path>?<params>" | jq '.'
```

**Expected browser health when connected:**
```json
{ "active": true, "ready": true, "profile": "<profile-name>", "domain": null }
```

**Common L2 failures:**
- `503 { "error": "Browser not connected" }` → Connect the browser first via WebSocket
- `404` → Route not registered in `register-domains.ts` or path typo
- `500` → Handler threw an error — check server logs

---

### L3 — Browser + Traffic Capture

Connect the browser and verify it can navigate and capture traffic.

```bash
# After connecting via WebSocket at ws://localhost:3001/browser/stream?profile=<name>&url=<url>

# Verify connected browser can navigate
curl -s "http://localhost:3001/api/<domain>/search?q=test" | jq '.total'

# Check traffic buffer (for Type B2 domains)
curl -s http://localhost:3001/browser/traffic | jq '[.entries[] | {url: .url[:100], status}]'

# Clear traffic buffer before a Type B2 test
curl -s -X DELETE http://localhost:3001/browser/traffic | jq '.'
```

**Type classification:**
- **Type A** — `targetUrl` proxy. Browser navigates to target, headers forwarded.
- **Type B** — `handler` with `page.evaluate()`. Browser navigates, DOM parsed server-side.
- **Type B2** — `handler` with traffic capture. Browser navigates, page JS fires XHR/fetch, buffer read.
- **Type C** — `handler` with `browserFetch()`. Single same-origin request, no navigation.

**Common L3 failures:**
- Browser navigates but page renders empty (stubborn page, CAPTCHA) → check page content with `page.evaluate(() => document.body.innerText.slice(0, 500))`
- Traffic buffer empty after navigation (Type B2) → XHR/API calls not firing; increase wait time
- RegionalDomain mismatch → filter extracted URLs to correct domain

---

### L4 — Dashboard UI

Use the `visual-dev` skill for screenshot-based validation.

**Validation checklist:**
- [ ] Empty state renders (no data, no errors)
- [ ] Loading state shows skeleton/spinner
- [ ] Data renders correctly after API call
- [ ] Error state shows clear message when API fails
- [ ] Interactive elements (search, click) trigger correct API calls and update state

```bash
# Quick smoke test — does the page load?
curl -s http://localhost:3000/<page> | grep -o '<title>[^<]*</title>'
```

---

## Gate Sequence

Run this sequence before calling a phase complete:

```bash
# Gate 1: Domain routes registered
curl -s http://localhost:3001/api | jq '.domains[].name'

# Gate 2: Browser connected and proxy works
curl -s "http://localhost:3001/api/<domain>/search?q=test" | jq '.total'

# Gate 3: Real data returned (not empty, not error)
curl -s "http://localhost:3001/api/<domain>/search?q=<real-query>" | jq '.events[0].name // .performers[0].name // .[0]'

# Gate 4: Listings/detail data returns
curl -s "http://localhost:3001/api/<domain>/listings/<id>" | jq '.listings[0]'
```

All four must pass before building UI.

---

## Fix Before Ascending

When a test fails at any layer, fix it before moving up. If L3 traffic capture is empty, check L2 proxy (is the right route called?), then L1 handler (is the wait time sufficient?). Don't move to L4 UI until L3 is clean.

## When Tests Fail Unexpectedly

Use the `debug-logs` skill to add targeted `DEBUG()` calls inside route handlers to observe what the browser page actually contains when the handler runs.
