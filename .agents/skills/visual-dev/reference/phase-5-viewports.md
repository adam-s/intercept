# Phase 5: Multi-Viewport Sweep

Run this on the most complex state (usually populated-with-variety). The viewport sweep reuses the already-authenticated page.

```typescript
const viewports = [
  { name: "mobile",  width: 375,  height: 812 },
  { name: "tablet",  width: 768,  height: 1024 },
  { name: "desktop", width: 1280, height: 720 },
  { name: "wide",    width: 1920, height: 1080 },
];

for (const vp of viewports) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `/tmp/interceptor-dev-screenshots/${pageName}-${vp.name}.png`,
    fullPage: true,
  });
}
```

Look for:
- **Mobile**: single-column, hamburger menu, no horizontal scroll
- **Tablet**: transitional layout, sidebar may collapse
- **Desktop**: full sidebar, multi-column where applicable
- **Wide**: content constrained (max-width working), not stretching to fill 1920px

Fix and re-screenshot per viewport. Same iteration protocol — one fix, one screenshot, judge.
