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
| 1 | [from prompt] | PASS/FAIL | [curl output or screenshot] |
```

Row 0 is a MANDATORY GATE — a filled elimination table must exist before any route code. ANY FAIL = fix before committing.
