---
name: debug-logs
description: Iterative debugging with targeted logs. Use when browser connections fail, traffic capture returns empty, proxy routes return errors, WebSocket issues, or any problem that can't be solved on the first attempt. Add logs, read output, narrow the search, repeat until fixed, then clean up.
---

# Iterative Debug Logging

When you can't solve a problem by reading code alone, use DEBUG() to observe runtime behavior. This is a methodical process — not a one-shot fix.

## The DEBUG() Function

Canonical implementation at `packages/shared/src/debug.ts`. Choose the import based on context:

```typescript
import { DEBUG } from "@interceptor/shared";  // server/API code (routes, handlers)
import { DEBUG } from "@/lib/debug";          // client components ('use client') — do NOT import @interceptor/shared in browser code
```

Call signatures:

```typescript
DEBUG('message')
DEBUG('location', 'message')
DEBUG('location', () => ({ data: value }))
DEBUG('location', 'message', () => ({ data: value }))
```

The data argument is a factory function (lambda) — expensive computation is deferred and only runs when logging is enabled. DEBUG is disabled in test and production (`NODE_ENV`).

Output goes to `/tmp/interceptor-debug/debug-YYYY-MM-DD.log` and console (cyan).

## The Process

### Step 1: Hypothesize

Before adding any logs, form a hypothesis about where the bug likely is. Ask:

- What is the symptom? (e.g., "counter is frozen", "state not updating", "wrong value displayed")
- What code path produces the visible output? Trace backwards from the symptom.
- Which functions sit between the input and the broken output?

### Step 2: Add targeted DEBUG() calls

Add 2-4 calls in the functions you suspect. Log the values that would confirm or reject your hypothesis. Be strategic — avoid noisy locations like tight loops unless you suspect the loop itself.

Good placement:
- At the entry of a function you suspect, logging its inputs
- At decision points (if/else branches) to see which path was taken
- Right before and after a value transformation to see what changed

Bad placement:
- Inside a loop that runs hundreds of times per second
- In functions you have no reason to suspect
- Logging entire objects when one field would suffice

### Step 3: Reproduce and read

Reproduce the bug. Then read the log:

```bash
cat /tmp/interceptor-debug/debug-$(date +%Y-%m-%d).log
```

If the file is missing or empty:
```bash
ls -la /tmp/interceptor-debug/
```

For live tailing while reproducing:
```bash
tail -f /tmp/interceptor-debug/debug-*.log
```

### Step 4: Narrow or widen

**If the logs reveal the bug** — fix it, go to Step 5.

**If the logs show expected behavior in the suspected area** — the bug is elsewhere. Widen scope:
- Remove the DEBUG() calls that proved unhelpful
- Add new ones in the next most likely location
- Move further up or down the call chain

**If the logs show something unexpected but you can't pinpoint why** — add more calls to narrow within the same area. Log intermediate values, branch decisions, loop iterations.

Repeat Steps 2-4 until the root cause is clear.

### Step 5: Clean up

After fixing the bug, remove DEBUG() calls that were only useful for this investigation. Keep a call only if:
- It logs a value that would be useful for future debugging of the same area
- It sits at a critical decision point that is hard to reason about from code alone
- It captures state that is otherwise invisible (e.g., values computed across multiple steps)

When in doubt, remove it. The calls are easy to add back.

### Step 6: Clear logs

```bash
rm -f /tmp/interceptor-debug/*.log
```

## Example

Symptom: "The SSE counter is frozen — client connects but count never updates."

**Hypothesis**: The broadcast function might not be sending updates.

**Add DEBUG()** in `broadcast()` and `tick()`:
```typescript
function tick(): void {
  count += multiplier;
  DEBUG("tick", () => ({ count, multiplier }));
  broadcast();
}

function broadcast(): void {
  const state = getState();
  const json = JSON.stringify(state);
  DEBUG("broadcast", () => ({ count: state.count, jsonMatch: json === lastJson }));
  if (json === lastJson) return;
  lastJson = json;
  // ...
}
```

**Read logs**: If you see tick incrementing but broadcast always showing `jsonMatch: true`, the dedup comparison is wrong — `lastJson` is being set before the check.

**Fix, then remove** the DEBUG() calls (or keep one in broadcast if the dedup logic is tricky enough to warrant permanent observability).
