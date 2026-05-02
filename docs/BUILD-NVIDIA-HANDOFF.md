# build-nvidia plugin — session handoff

Status as of 2026-05-02. The plugin is **working for the read surface** and
**partially working for chat** (bearer-keyed path is fine; browser-driven
captcha path is in active investigation).

For the deep rev-eng of hCaptcha vs. Sentinel/Turnstile, see
[`HCAPTCHA-VS-TURNSTILE.md`](HCAPTCHA-VS-TURNSTILE.md). This doc is the
"what's in the repo, how to run it, what's open" companion.

---

## What ships

### Browserless routes (production-ready)

All return real upstream data with no browser session attached. Verified
via `curl` with a NEW shell that has no `NVIDIA_API_KEY` and no connected
browser.

| Route | Purpose |
|---|---|
| `GET  /api/build-nvidia/catalog` | Full ENDPOINT catalog (~164 models, summary by default; `?raw=1` returns upstream JSON) |
| `GET  /api/build-nvidia/catalog/labelsets` | Filter labelsets (modality, providers, capabilities) |
| `GET  /api/build-nvidia/models/:vendor/:slug/spec` | OpenAPI 3.1 spec + parsed playground config + `nvcfFunctionId` |
| `GET  /api/build-nvidia/models/:vendor/:slug/partner-endpoints` | Partner cloud providers (Together AI, Bitdeer, GMI, Deep Infra, Vultr) |
| `GET  /api/build-nvidia/killswitches/:scope/:name` | Runtime feature flags pass-through |
| `GET  /api/build-nvidia/publishers/:publisher/logo` | Partner publisher logo URL |
| `POST /api/build-nvidia/chat/completions` | OpenAI-compatible chat — Bearer pass-through to `integrate.api.nvidia.com/v1`. Accepts `Authorization: Bearer nvapi-…` or `NVIDIA_API_KEY` env. Streaming-safe. |

### Browser-driven chat (still finicky)

| Route | State |
|---|---|
| `POST /api/build-nvidia/chat/completions/browser` | Drives the playground UI; no API key. **Currently hangs** — see "Open issues" below. |

### Debug / instrumentation routes

| Route | Purpose |
|---|---|
| `GET  /api/build-nvidia/debug/captcha/frame` | Walk `page.frames()`; return all hCaptcha frames + `typeof window.hcaptcha` inside each. Result confirmed FALSIFIED — see HCAPTCHA-VS-TURNSTILE.md "Phase 2". |
| `POST /api/build-nvidia/debug/captcha/mint` | Best-effort `hcaptcha.execute(sitekey)` via `frame.evaluate`. Always errors today (no SDK in iframe globals). Kept for future iframe-script versions. |
| `POST /api/build-nvidia/debug/captcha/pm/start?windowMs=N` | Install a parent-side `window.message` listener for hCaptcha origins; returns a tag |
| `GET  /api/build-nvidia/debug/captcha/pm/poll?tag=X` | Drain captured iframe→parent postMessages |
| `POST /api/build-nvidia/debug/bundles/start?tag=X` | CDP `Fetch.requestPaused` on `*hcaptcha.com*` + `*build.nvidia.com/_next/static/chunks/*` — dump bodies to `/tmp/build-nvidia-bundles/<tag>/` |
| `GET  /api/build-nvidia/debug/bundles/list?tag=X` | List captured scripts |
| `POST /api/build-nvidia/debug/bundles/stop?tag=X` | Stop capture |
| `POST /api/build-nvidia/debug/instrument/attach` | Install `window.__bn_instr` main-world hook on `fetch` + `XMLHttpRequest` for any URL hitting `api.ngc.nvidia.com` / `api.hcaptcha.com` / `hcaptcha.com`. Decorates `react-hcaptcha`'s `execute()` (fires Fetch.fulfillRequest — does NOT currently land bytes; see open issues). |
| `GET  /api/build-nvidia/debug/instrument/log` | Drain captured fetch/XHR entries + mutation events |
| `POST /api/build-nvidia/debug/instrument/detach` | Remove instrumentation |

---

## File map (created or modified this session)

```text
docs/
  HCAPTCHA-VS-TURNSTILE.md        # rev-eng comparison doc — primary reference
  BUILD-NVIDIA-HANDOFF.md         # this file

domains/build-nvidia/
  package.json                     # workspace dep
  src/
    index.ts                       # plugin manifest
    config.ts                      # interceptor patterns + base URLs
    interceptor.ts                 # extends GenericInterceptor
    routes.ts                      # all routes (read, chat, debug)
    browser-chat.ts                # UI-driven chat (Patchright fill+click)
    captcha-frame.ts               # frame probing + postMessage capture
    script-capture.ts              # CDP bundle capture
    instrument.ts                  # main-world fetch/XHR hook + decorator
  challenges/                      # copied from toolkit + adapted
    challenges.ts
    run.ts                         # supports --model, --challenge, multi-model matrix
    1-sqlite-windows/, 2-hono-websocket/, 3-csv-reporter/

apps/api/
  package.json                     # added @interceptor/domain-build-nvidia
  src/register-domains.ts          # registered + per-host rate limits

packages/browser/src/remote/
  cdp-script-control.ts            # NEW: ScriptMutator type + decorateScript()
                                   # method + Fetch.fulfillRequest path +
                                   # Network.setCacheDisabled when mutators registered
```

The old `domains/nvidia-build/` was removed earlier in the session per
user request — it was a single-purpose UI-driven chat plugin that
predates this discovery work and was causing namespace confusion.

---

## How to run from a cold start

```bash
# 1. API server
lsof -ti:3001 | xargs -r kill -9 2>/dev/null
pnpm --filter @interceptor/api dev > /tmp/api-server.log 2>&1 &
sleep 14

# 2. Hit the browserless reads with NO browser attached
curl -s http://localhost:3001/api/build-nvidia/catalog | jq '.total, .models[0]'
curl -s http://localhost:3001/api/build-nvidia/catalog/labelsets | jq '.labelSets | length'
curl -s http://localhost:3001/api/build-nvidia/models/openai/gpt-oss-20b/spec | jq '.nvcfFunctionId'

# 3. Bearer-passthrough chat (works browserlessly when key is set)
export NVIDIA_API_KEY=nvapi-…
curl -sN -X POST http://localhost:3001/api/build-nvidia/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"PONG?"}],"stream":true}'

# 4. Run the challenge harness against multiple models
pnpm tsx domains/build-nvidia/challenges/run.ts                       # full 5×3 matrix
pnpm tsx domains/build-nvidia/challenges/run.ts --model openai/gpt-oss-20b
pnpm tsx domains/build-nvidia/challenges/run.ts --challenge 1-sqlite-windows
```

For the **browser-driven** path:

```bash
# Connect a fresh profile (don't re-use a soft-banned one)
PROFILE="bn-$(date +%s)"
./scripts/connect-browser.sh --profile $PROFILE \
  --url https://build.nvidia.com/openai/gpt-oss-20b --port 3001 --timeout 120

# Attach instrumentation FIRST so init script registers before page reload
curl -X POST 'http://localhost:3001/api/build-nvidia/debug/instrument/attach'

# Reload to pick up the init script
curl -X POST http://localhost:3001/browser/mcp/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"script":"location.reload()"}'
sleep 14

# Drive the chat (currently hangs ~90s — see open issues)
curl -N -X POST http://localhost:3001/api/build-nvidia/chat/completions/browser \
  -H 'Content-Type: application/json' \
  -d '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"PONG?"}]}'

# Inspect what fired
curl -s http://localhost:3001/api/build-nvidia/debug/instrument/log | jq '.entries'
```

---

## What worked and what didn't (this session)

### Working

1. **Discovery (full 5-phase api-discovery)** — produced a 9-row Transport
   Elimination table, identified ~14 distinct endpoints, classified each
   for browserless reachability. ALL read endpoints are `Gap=N`.
2. **`integrate.api.nvidia.com/v1/chat/completions` Bearer pass-through** —
   one-line proxy in `routes.ts`. Streaming verified via SSE
   content-type passthrough. Confirmed 401 with no auth, 403 with bogus
   key — the proxy faithfully forwards.
3. **CDP bundle capture** — captured 61 NVIDIA Next.js chunks (~7 MB),
   identified the `@hcaptcha/react-hcaptcha` integration in chunk
   `81560-…js`. The hCaptcha iframe HTML downloads directly via curl
   (public CDN); 569 KB inline `<script>` with ECDSA `MEUC` hash header
   + browser-enforced CSP `sha256-…` pin. Self-checksum is **explicit
   and primary**.
4. **postMessage protocol observation** — captured 5 lifecycle events
   from the iframe: `t:"r"` (ready), `t:"ri"` (ready-init),
   `label:"get-url"` (RPC out), `label:"challenge-loaded"`,
   `label:"site-setup"` (carries the challenge JWT — `type:"hsw"` for
   the worker proof-of-work). Envelope shape:
   `{source:"hcaptcha", t|label, id:<widget>, lookup:<corr-id>, contents}`.
5. **Frame reachability** — `page.frames()` returns 4 frames including
   the two hCaptcha OOPIFs. `frame.evaluate(...)` works inside them
   (CDP attaches transparently). **BUT** `Object.keys(window)` inside
   each iframe returns ONLY standard DOM globals — no captcha SDK
   exports. The chatgpt `(0, eval)(SDK)` trick **does not transfer**.
6. **Main-world fetch/XHR hook** (init script) — `data-bn-instr`
   marker proves install. Once the stale-init-script issue was found
   and fixed (no idempotency guard, since the browser process can
   outlive an API restart), the hook captured every `api.ngc.nvidia.com`
   request fired during page load: catalog, spec, partner-endpoints,
   refresh polls. Logs include method, URL, headers, body preview,
   status, duration.

### Open issues

1. **Browser-driven chat hangs.** `POST /chat/completions/browser` calls
   `browserDrivenChat()` which uses `page.locator('button[aria-label="Send"]').click({force:true})`.
   On both the soft-banned profile AND a fresh profile, the click
   either doesn't fire React's `onClick` or fires it but the captcha
   never mints (zero `predict` POSTs, zero hCaptcha network activity
   captured by the main-world fetch hook). State after attempted send:
   textarea still contains the typed prompt, Send button still enabled.
   **Suspect:** headless Chrome (`headless=old`) has a low hCaptcha
   trust score and the invisible-mode mint silently fails. The original
   pre-discovery `nvidia-build` plugin (deleted earlier) reportedly
   worked — it may have benefited from a profile already warmed by
   manual interaction.
2. **`CdpScriptControl.decorateScript` doesn't deliver bytes.** The
   mutator runs (logged in `instrument.mutations`), `Fetch.fulfillRequest`
   is invoked with the new body, but the page receives the original
   bytes (`fetch('/_next/.../81560-…js')` from the page returns the
   un-mutated content). Hypothesised cause: Patchright's own CDP
   session also handles `Fetch.requestPaused` for the same target
   and races us. The capture path (read-only `Fetch.continueResponse`)
   works fine. **The init-script-only instrumentation path is the
   live workaround** — `instrument.ts` no longer relies on the
   decorator for actual visibility.
3. **`Fetch.enable` doesn't cross OOPIFs.** Our `CdpScriptControl` is
   rooted at the parent page's session; the hCaptcha iframe is a
   separate CDP target. Result: NVIDIA's chunks are captured, hCaptcha's
   iframe scripts are not. Workaround: curl the iframe HTML directly
   (CDN is public). Long-term: extend `cdp-script-control.ts` to
   attach to OOPIF targets.
4. **No fingerprint persona for build-nvidia.** chatgpt has a 35 KB
   persona init script that overrides ~55 properties Sentinel reads.
   We haven't ported that for hCaptcha. Might be needed to get the
   browser-driven path working on cold profiles. See HCAPTCHA-VS-TURNSTILE
   "Updated transferability assessment" for the collision-risk audit
   that needs to come first.

---

## Recommended next moves (in priority order)

1. **Diagnose the Send click.** Two cheap experiments before assuming
   it's a fingerprint / hCaptcha-trust issue:
   - Run `connect-browser.sh` with `headless: false` (requires
     plumbing — `service.ts:96` defaults to `true`). If non-headless
     fixes it, we know it's hCaptcha trust, not click delivery.
   - Add a debug route that calls `page.locator('button[aria-label="Send"]').click()`
     **without** `force:true`, and then immediately probes textarea
     value. If the textarea clears, React did fire — and the predict
     hang is a captcha issue. If the textarea stays filled, the click
     never reached React (independent of captcha).
2. **Fix `decorateScript` byte delivery** OR commit fully to the
   init-script path. Probably the latter — fetch hooks already give
   us full visibility, and bypassing the byte-mutation race avoids
   one whole class of headache.
3. **Port chatgpt's persona script** to build-nvidia, after the
   collision audit (the `Function.prototype.toString` interplay with
   hCaptcha's Sentry/Raven masking — see the comparison doc).
4. **Attach `Fetch.enable` to OOPIF targets** so we can capture
   hCaptcha's iframe-served scripts without curl-bypass.

Each of these is a half-day to a day. None depends on the others.

---

## Quick-reference greps

When you come back to this:

```bash
# Where is everything?
ls /Users/adamsohn/Projects/intercept2/domains/build-nvidia/src/
ls /Users/adamsohn/Projects/intercept2/docs/

# What's in the captured hCaptcha bundle?
S=/tmp/build-nvidia-bundles/initial   # set by /debug/bundles/start
grep -lE 'nv-captcha-token' "$S"/*.js  # NVIDIA-side captcha header injection
grep -lE 'react-hcaptcha|HCaptcha\.execute' "$S"/*.js

# What did the page actually fetch during a chat attempt?
curl -s http://localhost:3001/api/build-nvidia/debug/instrument/log | jq '.entries[] | select(.payload.url | test("predict|hcaptcha"))'
```
