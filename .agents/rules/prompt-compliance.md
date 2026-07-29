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

Row 0 is a MANDATORY GATE — a derived elimination table must exist before any
route code. Derived, not written: the capture produces it, so every ✓ carries
the call shape that proved it and no row can be a recollection.

Rows 2 and 3 are enforced by the tools rather than self-reported. `route-spec`
refuses an instrumented session and fails a route that declares no `upstream`,
so a PASS there means a command exited zero — cite the exit, do not describe it.

Row 1 guards breadth: a single GATHER pass reports what you happened to look at,
not what the site has. Evidence is the per-pass delta, and the final pass must
have added nothing.

Row 3 guards recall. Rows 0-2 all measure the routes you built; none asks what
you missed. Captured traffic is the ground truth available from inside a run —
an endpoint that fired provably exists — so every unaccounted one gets a route
or a written reason.

It is a floor, not a full answer, and the size of the gap is measurable: a page
that was merely loaded yields materially fewer call shapes than the same page
exercised, because interaction-gated endpoints never fire under passive
browsing. A floor from an unexercised page is a statement about page load.

Row 2 guards the routes themselves. Typecheck, lint, and build prove the code
compiles; only `route-spec` proves each route returns real data with honest
counts. Passing the first three and skipping this one is the green that means
nothing.

ANY FAIL = fix before committing.
