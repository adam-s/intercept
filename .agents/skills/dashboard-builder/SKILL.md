---
name: dashboard-builder
description: Build Next.js dashboard pages that consume domain proxy APIs. Use when the user wants to create a dashboard, build a UI page, add a search interface, display data from captured APIs, create comparison views, or build any frontend that calls /api/<domain>/ endpoints.
---

# Dashboard Builder

Create Next.js dashboard pages that consume domain proxy API endpoints. Each page lives in `apps/web/src/app/(dashboard)/` and uses shadcn/ui components.

**Development principle: DEBUG logging is mandatory.** The build loop IS the debug-log + screenshot loop. `import { DEBUG } from '@interceptor/shared'` in every new file. Add `DEBUG('component-name', () => ({ step, data }))` at every data flow point: API fetch, response parsing, state updates, render decisions. Build a component → check debug logs to verify data flow → screenshot it → fix what's wrong → re-screenshot. **Verification output is required input for the next step** (see CLAUDE.md "The Rule That Makes This Work").

**Single browser instance — sequential calls only.** See api-discovery skill "Gotchas" section for details and code patterns.

**Prompt compliance gate:** Before committing: list every prompt requirement, state evidence for each (curl output, screenshot, Patchright click). Any requirement without evidence = not done. Loop until all have evidence.

## Design By Reference — Match a Real Website

The best way to produce quality UI is to copy an existing one. When building a dashboard:

1. **Pick a real website as the template.** Choose a well-designed site that serves similar data. The gap between your screenshot and the template IS the bug. See `/packages/test-server` for test site examples and `/domains/boardshop/` for reference domain patterns.

2. **Screenshot the template.** Capture the target site at 1280x800 and 375x800 (mobile):
   ```bash
   node -e "
   const { chromium } = require('patchright');
   (async () => {
     const browser = await chromium.launch();
     const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
     await page.goto('TARGET_URL', { waitUntil: 'networkidle' });
     await page.screenshot({ path: '/tmp/template-desktop.png' });
     await page.setViewportSize({ width: 375, height: 800 });
     await page.screenshot({ path: '/tmp/template-mobile.png' });
     await browser.close();
   })();
   "
   ```

3. **Build to match.** After each change, screenshot your work AND read the template screenshot. Compare:
   - Layout structure (grid columns, sidebar, header position)
   - Information density (items per row, spacing between cards)
   - Typography hierarchy (title size vs metadata size)
   - Color usage (dark theme, accent colors, muted text)
   - Component patterns (card shapes, badges, thumbnails)
   - **Interactive controls** (upvote arrows, flag icons, hide/collapse buttons, vote affordances — if the template shows a control on each item, your dashboard must too)
   - **Element presence on every row/card** (check every row in both screenshots, not just the first)
   - **Navigation separators and spacing** (pipes, dots, dashes between nav links)

4. **The gap between screenshots IS the bug.** This is objective — no subjective "does it look good." Either your layout matches the template or it doesn't. Fix the differences.

5. **When the prompt adds features not in the wireframe:** Add new features in a way that preserves the wireframe's layout structure. Inline additions (badges on existing rows, tooltips on existing elements) are preferred over new layout sections (sidebars, panels, extra columns). If a feature requires a new layout section, place it BELOW the main content on mobile and as a narrow aside on desktop — never wider than 25% of the viewport.

### When the reference site's aesthetic conflicts with shadcn/ui defaults

If the reference site uses a legacy aesthetic (custom fonts, table-based layout, non-card list items), do NOT abandon shadcn/ui entirely. Instead:
1. Use shadcn/ui for **structure and behavior primitives** (Input, Button, Skeleton, Alert, Badge, Sheet) — these handle focus, accessibility, ARIA, and interaction.
2. Override **visual tokens only** with a scoped CSS class or inline `style` prop for brand colors and typography.
3. Never write a 400+ line custom CSS file to replace shadcn primitives. If you find yourself writing `.custom-search-input { border: 1px solid #ccc; }`, stop and use `<Input className="..." style={{ ... }} />` instead.

```tsx
// Prefer Tailwind classes when a utility exists
<Input className="w-36 h-6 text-[9pt] font-mono border-gray-300" placeholder="Search..." />

// Use inline style only for values Tailwind can't express (custom brand fonts, exact hex)
<Input
  className="w-36 h-6 text-[9pt]"
  style={{ fontFamily: 'Verdana, sans-serif' }}
  placeholder="Search..."
/>

// For plain-text link buttons (like HN "comments" or "More"):
<Button variant="link" className="p-0 h-auto text-[7pt] no-underline hover:underline"
  style={{ color: '#828282', fontFamily: 'Verdana, sans-serif' }}>
  {comments} comments
</Button>

// For error banners matching a non-shadcn aesthetic:
<Alert variant="destructive" className="rounded-none"
  style={{ background: '#ffe0e0', border: '1px solid #cc0000' }}>
  <AlertDescription>{error}</AlertDescription>
</Alert>
```

**The rule: if it's clickable, use `Button`. If it shows a status message, use `Alert`. Override the visual tokens, not the component choice.** A raw `<button>` or `<div>` with inline styles loses focus management, keyboard handling, and ARIA attributes that shadcn provides for free.

**Every clickable element must have a 44px minimum touch target.** This includes small visual elements like upvote arrows, star icons, and close buttons. Wrap small visuals in an accessible button: `<Button variant="ghost" size="icon" className="h-6 w-6 min-h-[44px] min-w-[44px]"><span className="text-xs">▲</span></Button>`.

Save template screenshots to `/tmp/template-<domain>/` for reference throughout the build.

## Visual Quality Standard

- **Spacing**: `gap-4`/`gap-6` between sections; `p-4` inside cards — no arbitrary pixels
- **Typography**: title `text-2xl font-bold` → labels `text-sm text-muted-foreground uppercase tracking-wide` → values `text-2xl font-semibold`
- **Color**: green = positive, red = negative, `text-muted-foreground` = secondary
- **States**: every container needs `<Skeleton>` (loading) + empty state message — never blank
- **Badges** for categorical values (sources, status, sentiment) — never raw text
- **Cards**: `border border-border/50 rounded-lg` — no heavy shadows

## Prerequisites — GATE: do not proceed without proof

Domain plugins registered, `pnpm run dev` (ports 3000/3001).

**Verify the data layer returns real data before building UI.** For HTTP routes: curl. For WebSocket streams: connect and observe messages. For any protocol: the verification must produce observable output proving real data flows end-to-end. If you can't verify it, you can't build on it.

**Type-verify the API response.** After curl-verifying an endpoint, compare the curl JSON output field names against your TypeScript response interface. If a field in your interface does not appear in the curl output (or vice versa), fix the type before writing any component code. `as ResponseType` does not validate at runtime — mismatched fields produce `undefined` silently.

**Routes must use network interception, not DOM extraction.** Every route that serves data must intercept a network request (XHR, WebSocket, GraphQL, etc.) — not parse rendered HTML via `page.evaluate()`. If a route uses `page.evaluate()` for data extraction, it violates the discovery protocol and must be rewritten. The Transport Elimination table from `discovery.md` must exist before any route is created.

If any endpoint returns empty or errors, stop and fix the API layer using debug-logs skill. If data looks wrong or encoded, see CLAUDE.md "Unexpected Output Is Information, Not Failure" — investigate the transformation before concluding something is broken.

## Step 0: Cache Fixture Data (before building ANY UI)

After API routes are proven with curl, cache ALL responses as fixtures. This eliminates browser dependency during UI development — every reload is instant (0ms vs 30-60s).

```bash
mkdir -p data/fixtures/{domain}
curl -s http://localhost:3001/api/{domain}/search?q=test > data/fixtures/{domain}/search.json
curl -s http://localhost:3001/api/{domain}/detail/123 > data/fixtures/{domain}/detail.json
```

Then develop with `FIXTURE_DIR=data/fixtures pnpm dev` — the API serves cached data instantly. Switch to live mode only for final integration testing.

**Why this is mandatory:** UI iteration requires 10-50 reloads. At 30-60s per live request, that's 5-50 minutes of pure waiting. With fixtures, it's under 1 second total.

## Component Architecture

Split components by view — one file per view, one shared types file. Each view component should be under 200 lines:
- `*-types.ts` — types, interfaces, helper functions, and shared constants (PAGE_SIZE, API paths, color maps)
- Reusable cards/items as separate components
- One file per view (search, channel, detail, downloads)
- Main content file is just the router/state switcher — under 150 lines
- Site chrome (header, footer, nav bar) goes in separate components even when they contain state-dependent logic. Pass state as props.
- Recursive components (e.g., CommentTree): extract the recursive item as a separate component file. The parent handles state/routing; the child handles rendering + recursion.

Run `pnpm biome check --write --unsafe .` before manual lint cleanup. Only manually fix what auto-fix can't.

## Steps 1-3: Plan + Create Route

1. Plan: data endpoints, interactions, layout, multi-domain composition
2. `mkdir -p apps/web/src/app/\(dashboard\)/<page-name>`
3. Create `page.tsx` importing a `<PageContent />` client component

**Layout group placement rule:** Pages that match a full-page reference site design (their own header, footer, and nav) should still be placed inside `(dashboard)/` and must add a local `layout.tsx` to opt out of the shared shell. Do NOT place the page outside the `(dashboard)` group — that removes it from the app's routing conventions and makes it invisible to the sidebar. If the reference site has its own nav/header, implement that nav inside the page component, not at the layout level.

```tsx
// apps/web/src/app/(dashboard)/<page-name>/layout.tsx — full-viewport overlay to cover parent sidebar
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 z-50 overflow-auto bg-background">{children}</div>;
}
```

**The content component must NOT contain `fixed inset-0` or `z-50`.** Viewport-level positioning belongs in the layout.tsx. The content component handles data and rendering only.

## Step 4: Client Component Template

Create `apps/web/src/app/(dashboard)/<page-name>/<page-name>-content.tsx` with `'use client'`. Use shadcn/ui components — not raw divs. Standard search page pattern:

- **URL state (not useState) for views:** Use `nuqs` hooks from `@/lib/url-state` for view switching, selected IDs, and search queries. This gives back button, deep linking, and shareable URLs for free:
  ```tsx
  import { useView, useSelectedId, useSearchQuery } from '@/lib/url-state';
  const [view, setView] = useView();       // ?view=list|detail|search
  const [id, setId] = useSelectedId();     // ?id=12345
  const [q, setQ] = useSearchQuery();      // ?q=search+term
  // Navigate: setView('detail'); setId(item.id);
  // Back to list: setView('list'); setId(null);
  ```
- State: `results`, `loading`, `error` (view/query/id are URL params, not useState)
- Fetch: `/api/<domain>/<endpoint>?q=${encodeURIComponent(q)}` (relative URL — see CLAUDE.md "Frontend API URLs")
- Layout: `flex flex-1 flex-col gap-4 p-6 max-w-4xl mx-auto w-full`
- Search bar: `Input` + `Button` with `onKeyDown Enter` handler
- Four render states: loading (`Skeleton` cards), empty ("No results for..."), idle ("Search above to get started"), populated (result `Card` list with hover)

**GATE: Screenshot the component before writing anything else.**

1. Take a Patchright screenshot of the page
2. Read the screenshot — describe in one sentence what you see
3. If the page shows an error, blank content, or broken layout: fix it NOW
4. If data is missing: add `DEBUG()` to the API route handler, re-fetch, read the log, fix
5. Re-screenshot after the fix — confirm the fix worked
6. Only proceed to the next component when the screenshot shows correct content

**You cannot add Step 5 (multi-domain composition) on top of a broken Step 4.** Each layer must be proven before building the next.

## Step 5: Multi-Domain Composition

Always sequential, catch per source. If a source returns null, mark offline — never let one failure break the page.

**Debug each source independently first.** Before composing sources together, `curl` each one and confirm it returns data. Add `DEBUG('fetch-sourceA', () => ({ status, count: data?.length }))` in the component's fetch function to see which source is failing at runtime. When sources are composed, a silent failure in one source produces confusing results in the merged view — debug logs tell you exactly which source returned null and why.

### Multi-domain comparison views — browser sequencing

When comparing data from two browser-dependent domains (e.g. two platforms showing the same product), the **singleton browser** navigates to each domain's page in turn. Each navigation clobbers the previous page state. This means:

1. **Frontend must call domains sequentially** — never `Promise.all`. Source A navigates, extracts data, returns. Then source B navigates, extracts, returns. The data from A is safe because it was already extracted and returned as JSON before B's navigation started.

2. **Show progress during sequential fetches** — tell the user which source is loading. `"Searching <domain-a>... (1 of 2)"` then `"Searching <domain-b>... (2 of 2)"`. Without this, the user sees a spinner for 20+ seconds with no indication of progress.

3. **Each source's route must fully extract before returning** — don't rely on the browser still being on the same page after the route handler returns. Navigate, wait, extract, return JSON. The next domain route will navigate away.

```typescript
// CORRECT — sequential, with progress updates
setLoadingMessage(`Searching ${sources[0].name}...`);
const resultA = await fetch(`/api/${sources[0].domain}/search?q=${q}`).then(r => r.json()).catch(() => null);

setLoadingMessage(`Searching ${sources[1].name}...`);
const resultB = await fetch(`/api/${sources[1].domain}/search?q=${q}`).then(r => r.json()).catch(() => null);

// Now merge — both datasets are in memory, browser state doesn't matter
const merged = mergeResults(resultA?.items ?? [], resultB?.items ?? []);
```

## Multi-Source Entity Merging

Merge by a **stable compound key** (not free-text titles) to avoid duplicate cards:

```typescript
function mergeKey(venue: string, date: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${norm(venue)}|${norm(date)}`;
}
const byKey = new Map<string, Record<string, unknown>>();
for (const item of sourceAResults) byKey.set(mergeKey(item.venue, item.date), { ...byKey.get(mergeKey(item.venue, item.date)), sourceA: item });
// repeat for sourceB...  each Map entry = one display row
```

**Rules:** Use stable fields (venue+date for events, company+title+city for jobs, DOI for papers). Normalize aggressively: lowercase, strip punctuation, parse dates to ISO. Normalize labels ("Section 101" = "Sec 101" = "101"). Single-source entities still appear with one badge.

**Filter before merging:** Validate results belong to the query. Use `startsWith` or word-boundary regex — not `includes`. Skip disqualifying keywords.

## Step 6: Final QA — GATE: zero issues or you're not done

**You have been screenshotting and debugging throughout Steps 4-5. This step is the comprehensive final sweep.**

Write a Patchright script that tests every user journey and captures every state:

```
1. Navigate to the page (first visit, no data) → screenshot → describe what you see
2. Perform a search → screenshot results → describe what you see
3. Click into a detail view → screenshot → describe what you see
4. Click every interactive element (buttons, favorites, filters, downloads) → verify each responds
5. Set viewport to 375x812 → screenshot → describe what you see
6. Check browser console for errors after each interaction
```

**For each screenshot:** Read it. Describe what you see in one sentence. If ANYTHING is wrong (broken layout, missing data, dead button, overlapping text, vague error message, content touching edges) — fix it, re-screenshot, confirm the fix.

**Iterate until screenshots show zero issues.** See visual-dev skill "Stopping Criteria" for the judgment framework.

**Only commit after this step produces zero-issue screenshots across all states and viewports.**

## Available UI Components

shadcn/ui — catalog: **https://ui.shadcn.com/docs/components**. Install upfront:

```bash
cd apps/web && npx shadcn@latest add card badge sheet table skeleton alert input button -y
```

### List view vs detail view

| Pattern | When | Implementation |
|---------|------|----------------|
| **Inline expand** | Detail fits 2-4 lines | Collapsible row or Tooltip |
| **Side sheet** (default) | Detail needs its own layout | `Sheet` from right, list stays visible |
| **Full page** | Detail has sub-nav/tabs/charts | `router.push('/item/[id]')` |

### Pagination

State: `page` (0-indexed), `PAGE_SIZE = 25`, `totalPages = Math.ceil(total / PAGE_SIZE)`. Fetch with `?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`. Reset page to 0 on filter change. Optional reusable pager: `apps/web/src/components/ui/grid-pagination.tsx` with `ChevronsLeft/Right` + `ChevronLeft/Right` buttons from lucide-react.

## Visual Design Guidance

### Required states (every page must implement all 8)

| State | What to show |
|-------|-------------|
| Idle | Icon in rounded container (`w-16 h-16 rounded-2xl bg-muted/50`) + heading (`text-base font-medium`) + description (`text-sm text-muted-foreground text-center`) + suggestion chips (`rounded-full bg-muted`) |
| Loading | `Skeleton` matching real content shape |
| Empty | Search icon (`w-10 h-10 mx-auto text-muted-foreground/40`) + message + sub-message with suggestions ("Try different keywords or check spelling") |
| Populated | Real content with typography hierarchy |
| Detail loading | `Skeleton` rows inside Sheet |
| Detail populated | Full detail with visual hierarchy. External links as outline buttons with external-link icon: `<Button variant="outline" size="sm" className="gap-1.5" asChild><a href={url} target="_blank">...</a></Button>` |
| Partial offline | `Alert` naming the failing source |
| Full offline | `Alert` per source with recovery instruction |
| Error | `Card` with `border-destructive/50` and user-facing error message. Silent `catch {}` blocks must at minimum set an error state. |

### Component choices

| Pattern | Component | Notes |
|---------|-----------|-------|
| List items | `Card` + `CardContent` | Never raw `<div>`. Hover state + border. |
| Source labels | `Badge` | Consistent color across all views |
| Detail view | `Sheet` from right | List stays visible behind |
| Comparison grid | `Table` | Rows = entities, cols = sources. Best value in green. Missing = `—` |
| Loading | `Skeleton` | Match real content dimensions |
| Errors | `Alert` + `AlertDescription` | Name the specific source, never generic |

### Responsive sidebar

```tsx
<div className="flex flex-col lg:flex-row gap-4">
  <div className="flex-1 min-w-0">{/* main content */}</div>
  <div className="w-full lg:w-72 flex-shrink-0"><Card>{/* sidebar */}</Card></div>
</div>
```

### Dark mode

Semantic tokens only: `bg-background`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `hover:bg-muted`. Accent: `bg-blue-950/30 border-blue-500/20` (not `bg-blue-50`).

### UX Patterns (required on every page)

| Pattern | Implementation |
|---------|---------------|
| Search bar icon | Search magnifying glass icon (`absolute left-3, w-4 h-4`) with `pl-9` on the input for instant visual recognition |
| Back button arrow | Every "Back" button needs a left arrow icon (`ArrowLeft w-4 h-4`) prepended for navigation affordance |
| Responsive padding | All content wrappers: `p-4 sm:p-6` (not just `p-6`). Mobile needs tighter padding. |
| Source count badges | When showing counts from multiple sources, use colored `Badge` components instead of plain text. Hide sources with 0 results. |
| Mobile action buttons | Buttons with text labels that don't fit on mobile should collapse to icon-only (`size="icon"`) with `className="sm:hidden"` / `className="hidden sm:flex"` |

## In-Process CRUD State

For user state (favorites, tracking, bookmarks) with no database requirement: dedicated domain plugin with module-level `Set`/`Map` + `browserRequired: false` routes. Resets on server restart. Register in `apps/api/src/register-domains.ts`.

**Optimistic UI:** Update React state immediately, fire API call in background. Don't await server sync before updating UI. `.catch(() => {})` — don't revert on network error.

## Cross-Source Entity Deduplication

Same pattern as Multi-Source Entity Merging above, but with `crossListed` tracking. Build `Map<key, { sources[], crossListed }>`. Normalize: lowercase, strip legal suffixes (Inc, LLC, Corp), strip punctuation.

**Cross-listed UI:** Show "N sites" badge on `crossListed: true` cards. In detail Sheet, show per-source price/salary comparison side by side. If prices differ: `"Source B lists $X higher"`.

### Status tracking in detail Sheet

Row of `Button` variants (`default` for active, `outline` for inactive), `size="sm"`, optimistic updates. Place below entity details in Sheet.

## Cross-Source Timeline View

Flatten + sort by date descending: `sources.flat().sort((a, b) => b.date.localeCompare(a.date))`. Each item: `{ date, type, title, subtitle, source, link }`. Visual: vertical line with colored dots per source. Tab bar for merged vs per-source views.

## Background Job Polling

For long-running operations: POST to start (returns `jobId`), store in `Map<jobId, Job>`, `useEffect` with `setInterval(1000)` polling active jobs. Auto-stop when all complete/error. Show `<Progress value={job.progress} />` + status `<Badge>`.

## Mini Sparkline (SVG, no deps)

Inline SVG `<polyline>`, map data points to coords, green (`#22c55e`) if up, red (`#ef4444`) if down. Filter nulls, compute min/max/range, scale to `120x32` viewbox. For complex charts: `@visx/shape` + `@visx/scale`.

## Mobile-First with Brand Colors

For brand-specific palettes, use a `COLORS` constants object with inline `style` (not Tailwind). Use `className` for layout (flex, gap, padding) and `style` for colors. Touch targets: `min-w-[44px] min-h-[44px]`. Bottom nav bar for mobile app feel.

## Nested Comment / Thread Tree

Recursive component with `depth` prop. Colored left-border per depth: `borderColor: hsl(${depth * 60 % 360}, 50%, 40%)`. Indent: `marginLeft: Math.min(depth, 6) * 16`. Click header to collapse/expand. Cap at maxDepth 6.

```tsx
function CommentTree({ comment, depth = 0 }: { comment: Comment; depth?: number }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div style={{ marginLeft: Math.min(depth, 6) * 16 }}>
      <div className="py-2 border-l-2 pl-3" style={{ borderColor: `hsl(${depth * 60 % 360}, 50%, 40%)` }}>
        <button onClick={() => setCollapsed(!collapsed)}>{/* author, score, timeAgo */}</button>
        {!collapsed && <>
          <p>{comment.body}</p>
          {comment.replies.map(r => <CommentTree key={r.id} comment={r} depth={depth + 1} />)}
        </>}
      </div>
    </div>
  );
}
```

## Video / Iframe Embed

Wrap `<iframe>` in `aspect-video` container. Prefer `-nocookie` embed domains. For local video: `<video controls>` with server-side `Content-Range` support.

### Static file serving with range requests

Return raw `new Response()` (not `c.json()`) with `Content-Range` headers. Prevent path traversal (`..` and `/` in filename). Import `createReadStream` from `node:fs`, `Readable` from `node:stream`. Status 206 for partial content.

```typescript
const range = c.req.header('range');
if (range) {
  const [startStr, endStr] = range.replace('bytes=', '').split('-');
  const start = parseInt(startStr), end = endStr ? parseInt(endStr) : stat.size - 1;
  return new Response(Readable.toWeb(createReadStream(filepath, { start, end })) as ReadableStream, {
    status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Type': 'video/mp4' },
  });
}
```

## API Call Pattern

Dashboard components use relative URLs: `/api/<domain>/<path>` (see CLAUDE.md "Frontend API URLs"). Browser must be connected or proxy returns 503. POST endpoints need `Content-Type: application/json`.

## Gotchas

| Problem | Fix |
|---------|-----|
| CORS error | Server has CORS enabled — check port |
| 503 from proxy | Connect browser at `/browser?profile=<domain>` |
| Empty results | `curl` the endpoint directly first |
| Unbounded list/table | Wrap in `max-h-[300px] overflow-y-auto` (lists) or `max-h-[600px] overflow-y-auto` (tables) — never let content grow unbounded inside a card |
| JSX comment in ternary | `{/* comment */}` inside `? :` breaks the parser — put comments outside the ternary or wrap in `<>` fragment |
| Hydration error | Add `'use client'` at top |
| Page not found | Directory name must match URL path |
| Fetch timeout on browser-dependent routes | `browserFetch` default is 20s — use `AbortSignal.timeout(45000)` on the dashboard fetch wrapper |

## Guiding Principles

These principles override the implementation patterns in this skill file. They do not override CLAUDE.md workflow rules or verification gates.

1. **An untested button is a broken button.** Walk the full user journey to reach it — don't test in isolation. `search → click result → scroll → click download → verify`
2. **Every view of the same entity is the same product.** If the watch page has rich metadata, the downloads page playing the same video must too.
3. **The first visit with zero setup IS the product.** No browser connected, no data seeded. If it shows an error, it's not done.
4. **Silent failure is the worst failure.** Empty `catch {}` = user stares at a spinner forever. Every catch must surface a message.
5. **Clickable things must look clickable. Non-clickable things must not.** No hover-only affordance — mobile has no hover. `cursor-pointer`, color, underline, or icon must be visible by default.
6. **Pass values, not state.** Never `setState(x)` then call a function that reads state — it sees the old value. Pass `x` as a parameter. `fetchResults(suggestion)` not `setQuery(s); handleSearch()`
7. **Error messages answer three questions: what, why, what now.** "Unavailable" fails. "Source unavailable — connect browser at /browser to enable" passes.
8. **Text never touches its container edge.** `p-4` minimum for cards, `p-6` for sheets. If text touches the border, spacing is broken.
9. **Every list item earns its click.** Title alone is never enough. Show title + subtitle + one metric. `"Kendrick Lamar"` fails. `"Kendrick Lamar · Jun 15 · Allegiant Stadium · from $89"` passes.
10. **Every input responds to Enter.** If you can type in it and there's a submit action, Enter triggers it.
11. **Sequential fetches need progress narration.** Show which source is being queried. `"Searching Source B... (2 of 3)"` not a generic spinner for 30 seconds.
12. **Normalize before merging.** Different formats of the same entity must produce the same key. `"Austin, TX"` and `"Austin TX"` must match. Trim, lowercase, strip punctuation.
13. **Mobile is a different product.** Test at 375px for: overlapping text, truncated inputs, hidden hover-only elements, 44px minimum touch targets, single-column layout.
15. **Small visual, large touch target.** When matching a reference site with tiny clickable text, keep the visual small but wrap it in a touch-friendly hit area: `<button className="min-h-[44px] min-w-[44px] flex items-center"><span className="text-xs">text</span></button>`. The rendered text stays small; the tap target is accessible.
14. **`dangerouslySetInnerHTML` requires a sanitization decision.** If an API returns HTML fragments, make one of these choices: (a) sanitize in the API route handler using `sanitize-html` before sending to the client, (b) sanitize in the component using `DOMPurify.sanitize(html)` before passing to `dangerouslySetInnerHTML`, or (c) document specifically why the source is trusted and what prevents injection. A biome-ignore comment alone is not sufficient documentation.

## Loading & Error Patterns

- **Per-platform state:** Track each data source independently: `{ data: T, loading: boolean, error: string | null }`. One source failing must not block or lose the other's results.
- **3-tier loading feedback:** (1) spinner icon on the trigger button, (2) `Skeleton` placeholders in the result container, (3) status text showing which source is active.
- **Retry with backoff:** Wrap fetches in a retry helper (2 retries, exponential backoff). On permanent failure, show a per-source "Retry" button — don't make the user redo the entire flow.
- **Error messages:** Map HTTP status codes to actionable strings. Never show raw status codes to users.
- **Caching:** Store fetched results in state so navigating between views doesn't re-fetch. Only re-fetch on explicit user action.
- **Every fetch — primary AND secondary — must set error state on failure.** Item fetches, detail fetches, and sub-list loads triggered by user interaction all require explicit error surfacing. A catch block that only calls `DEBUG()` and returns without calling `setError()` or `toast.error()` is a silent failure. Rule: if a catch block does not call `setError`, `toast.error`, or `setItemError`, it must have a comment explaining why the failure is intentional and non-user-impacting.

## Verification with Diverse Data

After building a dashboard, verify it works with **at least 3 different inputs** that exercise different data shapes:
- Different entities (different names, categories)
- Different result counts (0 results, 1 result, many results)
- Different matching outcomes (all sources match, partial match, no match)

If the dashboard only works for the first input you tested, it's not done.

**Verify utility functions with boundary values.** Time-relative functions (`timeAgo`, `formatDate`, `relativeTime`) must be tested with edge cases before shipping: a timestamp 30 seconds ago, 90 seconds ago, 90 minutes ago, 25 hours ago, 8 days ago. Test inline: `console.log(timeAgo(Date.now()/1000 - 30))` — confirm it returns "30 seconds ago", not "0 minutes ago".

## Definition of Done

**Use visual-dev skill + debug-logs skill. Every page must pass before committing.**

- [ ] Screenshot every state (empty, loading, populated, error, detail, mobile 375px) — judge against the 7 criteria
- [ ] Walk every user journey end-to-end via Patchright (search → results → detail → interact → back)
- [ ] Zero console errors on load and after each interaction
- [ ] Zero-setup first visit shows useful content or clear actionable guidance
- [ ] Padding, affordance, Enter key, error messages all pass the 13 principles above
- [ ] Produce the Prompt Compliance Matrix: one row per prompt requirement, PASS/FAIL with specific evidence. All rows PASS before committing.
