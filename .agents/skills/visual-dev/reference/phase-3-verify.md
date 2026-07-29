# Phase 3: Build + Verify Loop

## The Protocol

```
For each state in your enumeration:
  1. Set up the state (seed data, mock API, trigger action)
  2. Screenshot
  3. Judge against criteria
  4. If problems found:
     a. Fix ONE thing
     b. Re-screenshot
     c. Back to step 3
  5. If zero problems: move to next state
```

**Fix one thing at a time.** Multi-fix batches hide which change broke what.

## Judgment Criteria

Apply these 7 tests to every screenshot, ordered from most critical:

1. **3-second test** — Would a user know what's happening in 3 seconds?
2. **Data accuracy** — Does every value match the API response? Check truncation, decimals, units, timezone.
3. **Visual hierarchy** — Is the most important info most prominent?
4. **Interaction affordance** — Can you tell what's clickable vs decorative?
5. **Error communication** — When wrong: (a) obvious something went wrong, (b) what, (c) what to do about it?
6. **Empty states** — Clear message, not blank panel or stuck spinner.
7. **Density balance** — Dense enough to be useful, not so dense it's overwhelming.

## Stopping Criteria

The loop for a given state ends when you find **zero issues** across all 7 criteria. Not "looks fine" — genuinely zero. If you catch yourself thinking "probably okay," name the specific thing and decide.

The full page is done when every enumerated state passes at desktop viewport (1280x720).

## Writing the Patchright Script

Create `/tmp/interceptor-dev-screenshots/check.ts`. Use Patchright's **library API** (`chromium.launchPersistentContext`), not the test runner.

**CRITICAL**: Always use Patchright (`import { chromium } from "patchright"`), NEVER `@playwright/test`. Patchright is an anti-detection fork.

### Stealth Configuration (Required)

```typescript
const STEALTH_BROWSER_ARGS = [
  "--no-first-run", "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage", "--no-sandbox", "--disable-infobars",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
```

### Template: Authenticated Page with State Iteration

```typescript
import { chromium } from "patchright";

const BASE_URL = "http://localhost:XXXX"; // from prerequisite

async function main() {
  const ctx = await chromium.launchPersistentContext("", {
    headless: true, channel: "chromium",
    viewport: { width: 1280, height: 720 },
    userAgent: USER_AGENT, locale: "en-US", timezoneId: "America/New_York",
    args: STEALTH_BROWSER_ARGS,
  });

  const page = ctx.pages()[0] || (await ctx.newPage());

  // Login (always manual — storageState goes stale)
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.getByLabel("Email").fill("DISCOVERED_EMAIL");
  await page.getByLabel("Password").fill("DISCOVERED_PASS");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("DISCOVERED_REDIRECT", { timeout: 30_000 });
  await page.waitForTimeout(1000);

  // --- STATE: Populated ---
  await page.goto(`${BASE_URL}/flow`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/interceptor-dev-screenshots/flow-desktop-populated.png", fullPage: true });

  // --- STATE: Empty (mock API) ---
  await page.route("**/flow/trades*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ trades: [], total: 0 }) })
  );
  await page.goto(`${BASE_URL}/flow`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/interceptor-dev-screenshots/flow-desktop-empty.png", fullPage: true });
  await page.unrouteAll();

  // --- STATE: Error ---
  await page.route("**/flow/**", (route) => route.fulfill({ status: 500, body: "Internal Server Error" }));
  await page.goto(`${BASE_URL}/flow`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/interceptor-dev-screenshots/flow-desktop-error.png", fullPage: true });
  await page.unrouteAll();

  await ctx.close();
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

### Running

```bash
./node_modules/.bin/tsx /tmp/interceptor-dev-screenshots/check.ts
```

**Do NOT use `npx tsx`** — use the explicit local binary path.

### Script Rules

1. Library mode only — `launchPersistentContext()`, not `test()`
2. Always Patchright — never `@playwright/test`
3. Always `launchPersistentContext("")` — more stealthy
4. Always stealth args + real UA
5. Screenshots in gitignored directory
6. Descriptive filenames: `{page}-{viewport}-{state}.png`
7. Never `networkidle` — use `domcontentloaded` + element waits
8. Always close context — prevents orphan Chromium
9. Always manual login — `storageState` goes stale
10. New pages from context — `ctx.newPage()` for auth cookies

## State Setup Recipes

### Empty state
```typescript
await page.route("**/api/trades*", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ trades: [], total: 0 }) })
);
```

### Loading state
```typescript
await page.route("**/api/trades*", async (route) => {
  await new Promise((r) => setTimeout(r, 30_000)); // hold forever
  route.fulfill({ status: 200, body: "{}" });
});
// Navigate and immediately screenshot
await page.goto(`${BASE_URL}/flow`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/interceptor-dev-screenshots/flow-desktop-loading.png" });
```

### Error state
```typescript
await page.route("**/api/signal", (route) => route.fulfill({ status: 500, body: "Internal Server Error" }));
```

### Always clean up mocks between states
```typescript
await page.unrouteAll();
```
