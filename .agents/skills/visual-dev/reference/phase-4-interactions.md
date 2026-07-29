# Phase 4: Interaction Testing

**Design interactions based on your app model from Phase 1.** You understand the state machine — now verify transitions.

For each interactive element, reason about what should happen:
- What state change does this trigger? (local state, API call, SSE update)
- How long until the result is visible? (instant, ~1s for API, varies for SSE)
- What should change visually?

**Isolate what you're testing.** If the page has live-updating data (SSE, polling), background updates change values between screenshots. To verify a specific interaction:

1. **Pause live updates first** if the UI has a pause/stop control
2. **Or read a value that only your action changes** — e.g., multiplier text, not auto-incrementing count
3. **Or use element-specific assertions** instead of visual comparison

Script the verification:

```typescript
await page.screenshot({ path: "/tmp/interceptor-dev-screenshots/before-increment.png" });
await page.getByRole("button", { name: "+" }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/interceptor-dev-screenshots/after-increment.png" });
```

Read both screenshots and compare the value your action targets.

**Be creative** — don't just verify the happy path:
- Click buttons rapidly — does state stay consistent?
- Submit a form with empty fields — does validation appear?
- Navigate away and back — does state persist or reset correctly?
- Resize the viewport while SSE is active — does layout reflow cleanly?
