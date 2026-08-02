---
name: api-discovery
description: Discover any website's API and create domain plugins with proxy routes. Use when the user wants to create an API for a website, discover a web service's data transport, add a new domain, capture browser traffic, build typed API clients, or integrate with a third-party site. Also use when the user mentions a website name and wants to interact with it programmatically.
---

# API Discovery

## Consent check — **CRITICAL · MANDATORY**

**Check if `.agents/user-consent.md` exists with `ACCEPTED: true`.** If yes, display: `Prior consent on file (DATE). Proceeding.` and skip to "Phases."

If not, present the 3 warnings from `.agents/skills/instruction-tuning/SKILL.md` (ToS, autonomous agents, resource consumption). All 3 must be accepted. Write `.agents/user-consent.md` on acceptance. This file is shared across all skills that access external websites.

---

Discover how a website delivers data, then create a domain plugin that exposes it as a typed API.

**Before writing ANY code:** follow `.agents/rules/discovery.md` and produce the Transport Elimination table.

**Reference implementation:** `domains/boardshop/src/routes.ts` has working examples of every transport type against the test server.

## Phases

1. **Observe** — PRE-FLIGHT (write down what you know about the site), then GATHER (connect browser, navigate to a page with 100+ items, intercept pagination 2-3 times to capture the API pattern). Run GATHER to saturation — at least twice, until a pass finds nothing new; record the per-pass delta.
2. **Classify** — Run the discovery protocol per data type. Produce Transport Elimination table (MANDATORY GATE)
3. **Extract** — Write routes: start with browserFetch → run elimination → store minimum auth in GenericSessionManager → verify with rateLimitedFetch last. For Gap=Y: read session-harvest.md first.
4. **Verify** — `node scripts/route-spec.mjs` over every route, confirming real data AND honest counts (MANDATORY GATE — no dashboard until this passes). Lint/build prove compilation, not correctness.
5. **Scaffold** — Create domain plugin, register, test end-to-end. Command: `bash ${CLAUDE_SKILL_DIR}/scripts/scaffold-domain.sh <name> <root-domain>`

## References

- [reference/decoding.md](reference/decoding.md) — When API values don't match rendered DOM
- [reference/rate-limits.md](reference/rate-limits.md) — 429/403 troubleshooting checklist
- [reference/gotchas.md](reference/gotchas.md) — Singleton browser, background polling, multi-domain pages
- [reference/session-harvest.md](reference/session-harvest.md) — Capture, eliminate, trace, build: getting data from auth-gated endpoints
