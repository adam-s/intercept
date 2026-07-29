# Phase 2: Enumerate States

**Before taking any screenshots**, list every visual state the page can be in. This is the most important step. If you skip it, you'll verify the happy path and ship broken empty states, error states, and edge cases.

## How to enumerate

Start with the 8 required states from the dashboard-builder skill (Idle, Loading, Empty, Populated, Detail loading, Detail populated, Partial offline, Full offline). Then add domain-specific states unique to this page.

Think about the page as a state machine. For each data source, consider: what if it's empty? Loading? Errored? Populated with one item? Many items? Extreme values?

## Example: Trading dashboard states

1. **Empty** — No trades, no signals, no runs (first-time user)
2. **Loading** — Data fetching in progress (skeleton/spinner)
3. **Single open position** — One active trade
4. **Multiple positions** — Several active trades, testing density
5. **Position closed with profit** — Green P&L, positive numbers
6. **Position closed with loss** — Red P&L, negative numbers
7. **Signal = skip** — System decided not to trade today
8. **Job failed** — Pipeline error, error message visible
9. **Session expired** — Degraded mode indicator
10. **Mixed history** — Some wins, some losses, some skips

## Example: Form/config page states

1. **Default values** — Form loaded with defaults
2. **Modified values** — User changed something, unsaved
3. **Saving** — Submit in progress
4. **Save success** — Toast notification
5. **Validation error** — Invalid input highlighted
6. **Live mode warning** — Destructive action confirmation

Write your state list down before proceeding. Each state needs its own screenshot pass.
