# Getting Unstuck

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `goto` timeout (15s+) | Wrong port — another project's server | `curl` ALL listening ports, match `<title>` |
| `tsx: command not found` | PATH issue with `npx` | Use `./node_modules/.bin/tsx` |
| "Undeclared Automated Tool" / Stubborn Page | Using `@playwright/test` or missing stealth args | Use Patchright + `launchPersistentContext` + stealth args + real UA |
| "Request Rate Threshold Exceeded" | Too many requests | Wait 10+ min; add 2-3s delays |
| Redirected to `/login` after login | Wrong creds or cookies not persisting | Verify creds; use `ctx.newPage()` |
| Screenshot is blank/white | Page hasn't hydrated | `waitForTimeout(2000)` or wait for element |
| `networkidle` never resolves | SSE/WebSocket open | Switch to `domcontentloaded` + element waits |
| Stale UI after code change | Dev server hasn't hot-reloaded | Wait longer or restart server |
| `bg-blue-50` looks gray | Light-mode color on dark theme | Use opacity-based dark variant |
| Screenshot cuts off scrollable content | `fullPage` doesn't expand nested `overflow: auto` | Expand with `evaluate()` before screenshot |
| Form fields crammed against button | `<form>` breaks parent `gap` | Add `flex flex-col gap-6` to form |
| Panel stretches at 1920px | No max-width | Add `max-w-xl mx-auto` |

## Why Patchright, Not Playwright

**Playwright** sets `navigator.webdriver = true` and has fingerprints that automated access detection catches. Sites return CAPTCHAs or empty pages.

**Patchright** patches detection vectors at the Chromium level. Combined with stealth args, `launchPersistentContext`, and real User-Agent strings, it passes as a real browser. Verified working against government sites, financial data providers, and news services.
