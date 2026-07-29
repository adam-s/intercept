---
name: app
description: Build a complete application from a short description. Asks the developer clarifying questions, generates data requirements, launches discovery agents, and builds a dashboard. Use when the developer describes what they want to build in plain language — "compare tickets", "track prices", "search jobs across sites".
---

# App Builder

## Consent check — **CRITICAL · MANDATORY**

**Check if `.agents/user-consent.md` exists with `ACCEPTED: true`.** If yes, display: `Prior consent on file (DATE). Proceeding.` and skip to "Phase 0: Classify."

If not, present the 3 warnings from `.agents/skills/instruction-tuning/SKILL.md` (ToS, autonomous agents, resource consumption). All 3 must be accepted. Write `.agents/user-consent.md` on acceptance. This file is shared across all skills that access external websites.

---

Turn a plain-language description into a working application with domain plugins and dashboard UI.

The developer says WHAT. This skill figures out HOW — interactively.

## Phase 0: Classify

Before anything else, determine what the developer needs:

**Ask:** Is this a full app (API + dashboard), or API only (domain plugin with routes, no frontend)?

- **API only:** Phases 1-3 only. Deliver working proxy routes.
- **Full app:** All 5 phases. API first, then dashboard.

## Phase 1: Understand (interactive)

Have a conversation with the developer. Ask these questions — skip any already answered:

### Type
> App with dashboard, or API only?

### Sites
> Which website(s)? Can you give me a specific URL with the data you want?
> Example: "example.com — here's a page with 400+ listings: [url]"

A specific URL is 10x more valuable than a site name. It tells us the page structure, item count, and exactly where to look.

### Data
> What data do you need? Be specific about fields.
> Example: "ticket listings with section, row, seat, price" / "job postings with title, company, salary, location"

### Completeness
> All results (full pagination) or just the first page?

### Matching (multi-site only)
> How should I match the same entity across sites?
> Example: "by venue + date" / "by job title + company"

### View (full app only)
> What should the dashboard show?
> Example: "side-by-side price comparison" / "timeline" / "search with filters"

### Route (full app only)
> Dashboard URL path? (default: based on the domain name)

**Do not proceed until the developer answers.**

## Phase 2: Explore & Confirm

For each site, explore it together with the developer before launching any build work.

**2a. Connect browser and explore.**
```bash
./scripts/connect-browser.sh --profile <domain> --url <homepage> --port 3001
```

Navigate to the URLs the developer provided. Check traffic, count items, identify APIs.

**2b. Report findings to the developer:**
> Here's what I found on [site]:
> - [N] traffic entries: [list key endpoints]
> - Page has [N] items with [pagination type]
> - Embedded data: [yes/no, what framework]
> - API endpoints: [list with response shapes]
>
> Does this match what you expect? Anything I should look at more closely?

**2c. Developer confirms or redirects.** They might say "no, the ticket data loads when you click 'View Listings'" or "try searching for X instead." This saves the agent from guessing.

**2d. Write the spec** at `prompts/.app-spec.md` with everything learned:

```markdown
# App Spec: [name]

## Type: [app / api-only]

## Sites
### site1.com
- Target URL: [specific URL developer provided]
- Transport: [what we found — embedded JSON, XHR, GraphQL, etc.]
- Key endpoints: [URLs with methods and response shapes]
- Auth: [public / needs cookies / needs API key]
- Pagination: [type and params]
- Fields needed: [from developer's answer]

## Matching (if multi-site)
[compound key and normalization]

## Dashboard (if full app)
Path: /[route]
Layout: [description]
```

## Phase 3: Build API

**Create a branch first:**
```bash
git checkout -b app/<name>
```
All app work happens on this branch. Main stays clean.

Follow `.agents/rules/discovery.md` for the full protocol, but with the advantage of knowing exactly what to look for from Phase 2.

**3a. Build the domain plugin** — routes, config, interceptor, index. Use the spec from 2d.

**3b. Register and test every route** through the API proxy:
```bash
curl -s http://localhost:3001/api/<domain>/<route> | head -50
```

**3c. Cache real data for dashboard development.** Hit every route with representative inputs and save responses:
```bash
mkdir -p tmp/cache/<domain>
# Search/list results
curl -s "http://localhost:3001/api/<domain>/search?q=example" > tmp/cache/<domain>/search.json
# Detail page
curl -s "http://localhost:3001/api/<domain>/detail/123" > tmp/cache/<domain>/detail-123.json
# Pagination page 2
curl -s "http://localhost:3001/api/<domain>/search?q=example&page=2" > tmp/cache/<domain>/search-page2.json
# Edge cases: empty results, single result, max results
```

Cache enough data to build every view in the dashboard without hitting the live API: list views, detail views, empty states, pagination, cross-site matching samples.

**3d. Commit checkpoint.** The working domain plugin + cached data is a safe checkpoint. If dashboard iterations go sideways, we never lose the API work.
```bash
git add domains/<name>/ apps/api/src/register-domains.ts apps/api/package.json
git commit -m "feat: add <domain> domain plugin with <N> routes"
```

**If API only:** Done. Show the developer the route list and sample responses.

## Phase 4: Dashboard (full app only)

Build the dashboard UI against cached data. This decouples UI iteration from API reliability — no browser sessions, no rate limits, no WAF while tweaking CSS.

**4a. Scaffold the page** at `apps/web/app/<route>/page.tsx`.

**4b. Wire up data fetching.** Start with cached data to verify layout, then switch to live API calls.

**4c. Iterate with the developer.** Use `visual-dev` skill — screenshot after each change, show the developer, get feedback, fix, re-screenshot. Don't build blind.

**4d. Use `debug-logs` skill** when data isn't flowing: add targeted DEBUG logs at each layer (route handler → API fetch → response parse → component render), read output, fix, clean up.

**4e. Handle multi-source merging** if applicable — match entities across sites using the key from the spec, show source badges, highlight differences.

## Phase 5: Verify (full app only)

Bottom-up validation using `systematic-testing` skill:

1. Curl every API route — confirm real data
2. Screenshot the dashboard: empty, loading, populated, error, mobile (375px)
3. Walk the full user journey: search → results → detail → compare
4. Test with 3 different inputs
5. Show the developer screenshots and sample data

**Only hand off when verified working on localhost:3000.**

## Python Bridge

The project includes a Python worker at `services/python/` that can be called from route handlers or dashboard API routes. Use it for anything that's better in Python than TypeScript:

**NLP & Text Analysis:**
- Sentiment analysis on reviews, news headlines, social posts (NLTK, TextBlob, transformers)
- Named entity recognition — extract people, companies, locations from text
- Text summarization — condense long descriptions or reviews
- Keyword extraction — pull topics from listings or job postings

**Data Science:**
- Fuzzy entity matching across sites (fuzzywuzzy, rapidfuzz, scikit-learn cosine similarity)
- Statistical outlier detection — flag unusually priced listings
- Clustering — group similar items (KMeans, DBSCAN on feature vectors)
- Trend analysis — price changes over time, moving averages

**Machine Learning:**
- Classification — categorize items, detect spam/duplicates
- Regression — predict prices, estimate value scores
- Feature engineering — normalize and compare across different site schemas

**When to use the Python bridge:**
- The developer's spec mentions sentiment, scoring, matching, analysis, or ML
- Cross-site entity deduplication (Python fuzzy matching >> JS string comparison)
- Any computation where numpy/pandas/scikit-learn is the natural tool

**How:** Route handlers call the Python bridge via IPC. The bridge runs as a sidecar service. See `services/python/` for the interface.

## Rules

- The developer's domain knowledge is the most valuable input. Ask for it. Don't guess.
- Commit after Phase 3. The API is the foundation — protect it.
- Cache real data. Dashboard iterations should never depend on a live browser session.
- If a site requires browser session for some routes, say so in the spec. Don't hide limitations.
- The spec file is temporary. The domain plugin, cached data, and dashboard are the product.
