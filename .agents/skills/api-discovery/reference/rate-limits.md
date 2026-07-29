# Rate Limiting and Access Troubleshooting

When an API returns 429 or 403, work through in order:

## Step 0: Poisoned browser profile (most common cause)

**Symptom:** All endpoints 429, but same URL returns 200 in incognito. `age: 0` on 429 response (hitting origin, not CDN).

**Fix:** `rm -rf data/browser-profiles/<domain> && mkdir data/browser-profiles/<domain>` — reconnect for a fresh session. **Always ask the user before wiping** — profiles may contain hard-to-reproduce auth state.

**When NOT to wipe:** Both curl and browser return 429 (IP-level block — wait 15-60 min), or only certain endpoints 429 (CDN/origin split).

## Step 1: Compare which endpoints succeed vs fail

| Pattern | Root cause | Fix |
|---------|-----------|-----|
| All 429 | IP globally rate-limited | Wait 1-24h; proxy IP; reduce frequency |
| Some 200 (CDN), others 429 | Stubborn real-time endpoints | Check `sec-ch-ua` (Step 2) |
| API 429, page loads 200 | Missing session token | Check for crumb/CSRF (Step 3) |

## Step 2: Inspect `sec-ch-ua`

If `"HeadlessChrome"` appears in captured `sec-ch-ua` headers, the browser is being fingerprinted. Framework overrides this in `service.ts` — restart server to pick up the fix.

## Step 3: Session tokens (crumb, CSRF)

Some APIs require a short-lived token from the page load. Check successful traffic for `crumb`, `csrf`, `token` params. Cache in a module-level variable — refresh on 401.

| Token | Source | Usage |
|-------|--------|-------|
| `crumb` | Dedicated endpoint or page JS | `&crumb=VALUE` query param |
| `csrfToken` | `<meta name="csrf-token">` or JS globals | `X-CSRF-Token` header |

## Step 4: Missing cookies

If auth cookies aren't reaching API calls, the browser may not be on the site's origin. Navigate to main site first, wait for load, then make API calls.

## Step 5: Cross-origin CORS

If traffic shows `access-control-allow-origin` + `access-control-allow-credentials: true` on subdomain responses, use `navigateTo` in `browserFetch`.
