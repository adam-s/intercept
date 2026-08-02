# Session Harvest

When the Access Gap table shows endpoints that work in the browser but fail with direct HTTP (401, 403, empty data), the site requires cookies, headers, or tokens that only a real browser session produces. Session harvest is the process of figuring out exactly what's needed and building a route that obtains and replays those values.

## For Gap=Y endpoints with pagination buttons: click-intercept

When the endpoint is WAF-gated AND the page has a pagination button, the simplest approach is: **let the browser do the work.**

If the page has a "Show more", "Load more", or pagination button, the browser already knows how to make the right request — with all the correct cookies, headers, CSRF tokens, and body. You just need to click the button and capture the response.

```typescript
import { chromium } from 'patchright';

const ctx = await chromium.launchPersistentContext('/tmp/profile', {
  headless: true, channel: 'chromium',
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = await ctx.newPage();

// Collect all POST responses
const responses: Array<{ url: string; body: unknown }> = [];
page.on('response', async (res) => {
  if (res.request().method() === 'POST' && res.status() === 200) {
    try {
      const json = await res.json();
      if (json.items || json.totalCount) {
        responses.push({ url: res.url(), body: json });
      }
    } catch {}
  }
});

await page.goto(eventUrl);
await page.waitForTimeout(5000);

// Dismiss any modals (quantity selectors, cookie banners, etc.)
const modal = page.locator('button:has-text("Continue"), button:has-text("Accept")');
if (await modal.count() > 0) await modal.first().click({ force: true });

// Click "Show more" and collect pages
while (true) {
  const btn = page.locator('button:has-text("Show more"), button:has-text("Load more")');
  if (await btn.count() === 0) break;
  await btn.click();
  await page.waitForTimeout(2000);
  // responses array now has the next page of data
}

await ctx.close();
// responses[] contains all paginated data
```

This handles WAF cookies, CSRF, session tokens — everything — because the browser's own JavaScript makes the request. You don't need to reverse-engineer the POST body or harvest cookies manually.

**When click-intercept doesn't work** (no button, infinite scroll with no trigger, or you need to call the API from your route handler without a browser), fall back to the three-phase process below.

## The three-phase process

For cases where you need to replay requests without a browser (building a route handler that uses `rateLimitedFetch`), use these phases in order.

### Phase 1 — Capture a working request

The browser's intercepted traffic already contains working requests. Use `GenericInterceptor` (from `@interceptor/browser`) or the raw traffic capture to get the full request — URL, method, all headers, all cookies, body.

```typescript
// Attach interceptor to capture requests
import { GenericInterceptor } from '@interceptor/browser';

interceptor.onIntercept((req, res) => {
  if (req.url.includes('/api/target-endpoint')) {
    console.log('Headers:', req.headers);
    console.log('Status:', res.status);
    console.log('Body:', res.body);
  }
});
```

Or from traffic capture:
```bash
curl -s http://localhost:PORT/browser/traffic | python3 -c "
import sys, json
for e in json.load(sys.stdin).get('entries', []):
    if 'target-endpoint' in e['url']:
        print('URL:', e['url'])
        print('Method:', e['method'])
        print('Headers:', json.dumps(e.get('requestHeaders', {}), indent=2))
        print('Cookies:', e.get('requestHeaders', {}).get('cookie', ''))
        print('Status:', e.get('status'))
"
```

Save the full headers and cookies. This is your known-good baseline.

**Replay immediately to verify.** Before doing anything else, replay the captured request from Node.js with ALL headers and cookies intact. If the replay returns the same data as the browser got, you have a working baseline. If it fails, the site may check TLS fingerprint — try `browserFetch` instead.

### Phase 2 — Elimination

Replay the working request from Node.js `fetch` with ALL captured headers and cookies. Confirm you get the same response. Then remove values one at a time:

```
Start: all 12 headers + 8 cookies → 200 OK, full data
Remove cookie A → still 200 → A is not required
Remove cookie B → 403 → B IS REQUIRED (add it back)
Remove cookie C → 200 but empty data → C IS REQUIRED FOR DATA (add it back)
Remove header X → still 200 → X is not required
Remove header Y → 401 → Y IS REQUIRED (add it back)
...
```

This takes ~30 seconds and produces the **minimum auth set**: the smallest combination of cookies + headers that still returns full data.

**Watch for the WAF trap:** A request might pass the WAF gate (200 instead of 403) but return empty data. Always check that the response contains actual data, not just a successful status code. This is why you must test removing each cookie individually even after the request "works."

**Different endpoints may need different sets.** Run elimination separately for each Gap=Y endpoint. The event detail page might need cookies A+B, while the pricing API needs cookies A+C+header D.

### Phase 3 — Trace encoded/opaque values

If the minimum auth set includes values you can't just copy (they expire, rotate, or look encoded):

1. **Search embedded JSON** (`__NEXT_DATA__`, `window.__CONFIG__`, `<script type="application/json">`) for the value or its key name. API keys, secrets, and client IDs are almost always embedded in the page source.

2. **Search JS bundles** for the header name or cookie name. Find where the value is set:
   ```bash
   grep -oE '.{0,40}apiKey.{0,40}' bundle.js
   grep -oE '.{0,40}x-custom-header.{0,40}' bundle.js
   ```

3. **Trace the dependency chain.** Some values come from prior API calls:
   - Visit page A → server sets cookie X via `Set-Cookie`
   - Page A's JS calls API B with cookie X → response contains token Y
   - API C (your target) needs both cookie X and token Y

   Map the full chain. Your route must replay each step.

4. **For JS-challenge cookies** (WAF tokens, verification cookies): these are set by JavaScript execution, not by `Set-Cookie` headers. `rateLimitedFetch` to the seed page will NOT get them. You need Patchright:
   ```typescript
   // Launch browser, navigate, let JS challenges complete
   const context = await browser.newContext();
   const page = await context.newPage();
   await page.goto(seedUrl);
   await page.waitForTimeout(5000); // let WAF JS execute

   // Extract ALL cookies including httpOnly
   const cookies = await context.cookies();
   const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

   // Now use plain fetch with these cookies
   const res = await rateLimitedFetch(apiUrl, {
     headers: { Cookie: cookieStr, ...otherRequiredHeaders }
   });
   ```

## When `Set-Cookie` works vs when you need Patchright

| Signal | Cookie source | Approach |
|--------|--------------|----------|
| `Set-Cookie` header visible in response | Server sets it directly | `rateLimitedFetch` to seed page, parse `Set-Cookie` |
| Cookie appears in browser but NOT in any `Set-Cookie` response | JavaScript challenge sets it | Patchright `context.cookies()` |
| Cookie value changes on every page load | Dynamic JS generation | Patchright — must execute JS each time |
| Cookie survives across sessions | Server-set, long-lived | `rateLimitedFetch` once, cache with TTL |

## Building the route

After elimination, your route does three things:

1. **Harvest** — obtain the minimum auth values (seed page fetch or Patchright visit)
2. **Request** — call the target API with harvested values
3. **Paginate** — if the response has totalCount > items returned, loop with offset/page params

```typescript
handler: async (c) => {
  // 1. HARVEST — get required cookies/tokens
  // (use rateLimitedFetch for Set-Cookie, Patchright for JS-challenge cookies)
  const seedRes = await rateLimitedFetch(seedUrl);
  const cookie = seedRes.headers.get('set-cookie')?.match(/session=([^;]+)/)?.[1];

  // 2. REQUEST + 3. PAGINATE
  const allItems = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const res = await rateLimitedFetch(`${apiUrl}?offset=${offset}&limit=20`, {
      headers: { Cookie: `session=${cookie}` },
    });
    const data = await res.json();
    allItems.push(...data.items);
    hasMore = data.hasMore;
    offset += 20;
  }

  return c.json({ items: allItems, totalCollected: allItems.length });
}
```

## Reference implementations

- **Boardshop Route 30** (`domains/boardshop/src/routes.ts`): Pattern A — httpOnly cookie from `Set-Cookie` + embedded API keys from `window.__DROPS_CONFIG__`. Uses `rateLimitedFetch` for both harvest and pagination.
- **Boardshop Route 31** (`domains/boardshop/src/routes.ts`): Pattern B — multiple cookies where WAF cookie alone passes the gate but returns empty data. All session cookies required for actual data.

## Common mistakes

- **Using `browserFetch` and stopping when it returns partial data.** `browserFetch` inherits the page's cookies but may not have all WAF/session cookies if the page hasn't completed JS challenges. If `browserFetch` returns partial data (e.g., 16 items when totalCount says 3000), switch to Patchright: navigate to the page, wait for JS challenges to complete, then harvest cookies via `context.cookies()` and replay with `rateLimitedFetch`. See Route 31 in boardshop for this exact pattern.
- **Using `rateLimitedFetch` to harvest JS-challenge cookies.** WAF tokens are set by JavaScript execution, not `Set-Cookie` headers. If the cookie doesn't appear in the HTTP response, you need Patchright.
- **Stopping at the WAF gate.** Getting past 403 is step one. Verify the response contains actual data — WAF-pass + empty data means you're still missing session cookies.
- **Assuming one elimination covers all endpoints.** Run elimination per endpoint. The auth requirements often differ.
- **Reporting the gap instead of solving it.** A route that returns `{ error: "needs browser session" }` or marks itself as "needs real browser" is not a route. Harvest the session and return data. The path is always: Patchright `context.cookies()` → replay with `rateLimitedFetch` → paginate.
