---
description: Before committing, every requirement is listed with evidence
paths:
  - "domains/**"
  - "apps/web/**"
---

# Prompt Compliance Gate

Before committing, list every requirement with evidence. Any row without evidence = not done.

```
## Prompt Compliance Matrix
| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| 0 | Transport Elimination table produced | PASS/FAIL | Link to table |
| 1 | GATHER run to saturation (final pass added nothing) | PASS/FAIL | Per-pass new-finding counts |
| 2 | `node scripts/route-spec.mjs` passes | PASS/FAIL | Its output |
| 3 | `--mode=coverage` run; every unaccounted endpoint explained | PASS/FAIL | Its output + a line per endpoint |
| 4 | [from prompt] | PASS/FAIL | [response body or screenshot] |
```

Row 0 is a MANDATORY GATE — a filled elimination table must exist before any route code.

Row 1 guards breadth: a single GATHER pass reports what you happened to look at,
not what the site has. Evidence is the per-pass delta, and the final pass must
have added nothing.

Row 3 guards recall. Rows 0-2 all measure the routes you built; none asks what
you missed. Captured traffic is the one available ground truth — an endpoint
that fired provably exists — so every unaccounted one gets a route or a written
reason. It is a floor, not a full answer: interaction-gated endpoints never fire
under passive browsing, so the real surface is larger than the number shown.

Row 2 guards the routes themselves. Typecheck, lint, and build prove the code
compiles; only `route-spec` proves each route returns real data with honest
counts. Passing the first three and skipping this one is the green that means
nothing.

ANY FAIL = fix before committing.
