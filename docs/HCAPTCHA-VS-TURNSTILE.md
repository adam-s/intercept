# hCaptcha (build.nvidia.com) vs. Turnstile / Sentinel (chatgpt.com)

A side-by-side reverse-engineering reference for the two captcha-gated chat
APIs in this repo, and a concrete plan for what we can transplant from the
working ChatGPT playbook into the new `build-nvidia` plugin.

Companion doc: [`domains/chatgpt/TURNSTILE.md`](../domains/chatgpt/TURNSTILE.md)
is the source of truth for the ChatGPT side. This document assumes you've
read it (or that the summaries here are sufficient) and focuses on **what's
different about hCaptcha and what that means for our tooling**.

Scope: discovery confirmed against `build.nvidia.com/<vendor>/<model>` on
2026-05-02. The comparable ChatGPT findings are dated 2026-05-01. Anything
labelled "hypothesis" still needs a controlled test before we depend on it.

---

## TL;DR

- **Same goal, different architecture.** Both gates protect a chat
  completion POST with a per-request, short-lived, server-signed token.
  Both are unbreakable from pure Node without going through a real browser.
  Both are amenable to the same hybrid pattern (browser mints, Node
  fetches) — but **only** if we can call the SDK from outside the gated
  frame. ChatGPT lets us; hCaptcha doesn't.
- **The wall is iframe isolation, not crypto.** Sentinel ships its SDK as
  a normal JS file (`/sentinel/<hash>/sdk.js`); we evaluate it into the
  parent's main world via `(0, eval)(...)` and call `SentinelSDK.token()`
  directly. hCaptcha runs entirely inside a cross-origin iframe at
  `newassets.hcaptcha.com`; `window.hcaptcha` is undefined in the parent
  and `iframe.contentWindow` is sealed by Same-Origin Policy. The token
  is minted by code we can never reach in the same realm.
- **What still applies.** Persona spoofing (Layer 1 fingerprint),
  behavioural pre-seeding, Fetch-based body capture, init-script
  installation, and the broader "browser-as-token-factory, Node-as-
  transport" pattern. Init scripts in particular **do** propagate into
  cross-origin iframes (Chromium feature) — so we can still control the
  fingerprint hCaptcha sees from inside its own iframe.
- **What does not apply.** The eval-the-SDK-into-the-parent trick, direct
  `SDK.token('next')` calls, and any token-pre-mint pipeline that doesn't
  go through the React Send handler.
- **Recommended path.** Stay on browser-driven for chat (UI-driven Send +
  `page.waitForResponse`), but capture the request via CDP
  `Fetch.requestPaused` and replay it from Node. That gives us streaming
  to the client, transport off the browser thread, and a clean place to
  hang debug logs — without trying to bypass hCaptcha at all.

---

## At-a-glance comparison

| Concern | ChatGPT (Sentinel + Turnstile) | NVIDIA (hCaptcha invisible) |
|---|---|---|
| Protected endpoint | `POST /backend-anon/f/conversation` | `POST api.ngc.nvidia.com/v2/predict/models/qc69jvmznzxy/<slug>` |
| Token header(s) | 3 headers: `OpenAI-Sentinel-Proof-Token` (`p`), `-Turnstile-Token` (`t`), `-Chat-Requirements-Token` (`c`) | 1 header: `nv-captcha-token` (`P1_…`) |
| Function ID / model ID | Implicit in body (`model: "auto"`) | `nv-function-id: <uuid>` header (per-model, public — comes from `/v2/endpoints/.../spec`) |
| Token format | 3 different envelopes: `gAAAAAC<base64>` (proof), `gAAAAA<base64>~S` (proof-of-work), XOR-encoded (turnstile). All carry plaintext arrays the client built — no real Fernet | `P1_<JWT>` — JWT shell with msgpack payload `{pd, exp, passkey, kr, shard_id}`. The 1.1 KB `passkey` blob is opaque (server-side hCaptcha verifier holds the key) |
| Token TTL | Seconds (per-message; SDK re-mints every submit) | ~120 s. Single-use claimed; **uncontrolled-tested** |
| Where the SDK runs | Parent main world after we manually load it via `(0, eval)('/sentinel/<hash>/sdk.js')`. Default load path is inside an OpenAI-controlled iframe (`/backend-api/sentinel/frame.html`), but the SDK self-checks `window === window.top` so calling it from there is impossible | Cross-origin iframe at `https://newassets.hcaptcha.com/captcha/v1/<hash>/static/hcaptcha.html`. SDK is **never** exposed to the parent — `window.hcaptcha` is undefined |
| Reachable from parent? | Yes once we eval the SDK file into the parent — `window.SentinelSDK.token(flow)` returns the three tokens directly | No. Same-Origin Policy blocks `iframe.contentWindow.hcaptcha` from cross-origin frames. Communication is `postMessage` only |
| Reachable from inside the iframe via `frame.evaluate`? | Yes — Patchright frames work, but the SDK refuses to run inside the OpenAI iframe (`window === window.top` check) | **Hypothesis (untested)**: yes for `frame.evaluate` because Patchright/CDP attaches to OOPIF targets; hCaptcha doesn't have an obvious "must be top window" check. Worth one targeted experiment |
| Sitekey / public identifier | None (the gate is anonymous-Bearer + cookie-bound) | `0c6a1e45-75d7-43cc-b836-a0c9d886b8ee` (NVIDIA's hCaptcha sitekey, visible in iframe URL & a parent-side data attribute) |
| Encryption envelope | Three plaintext-but-stringified blobs concatenated under cosmetic `gAAAAA…` prefixes; the prefix is fake Fernet — string concatenation only | Real JWT (HS256) with msgpack body. Header public, payload public-readable but `passkey` blob is real opaque ciphertext signed server-side |
| Layer 1 fingerprint inputs | ~55 properties read by Cloudflare Turnstile bytecode + ~36 OpenAI Signal Orchestrator properties + 3 React-internal probes (Layers 1/2/3) | Inferred from hCaptcha public docs and the `passkey` size: navigator surface, WebGL, screen, fonts, AudioContext, behavioural counters, plus hCaptcha-specific reCAPTCHA-v3-style risk score inputs (mouse path, keystroke timing, page focus, dwell time) |
| Behavioural surface | `window.__oai_so_*` (kt_count, mv_dist, idle_ms, …) read at submit-time | Aggregated and sent inside the iframe; not visible on the parent's `window` |
| Detection of `navigator.webdriver` | Verified — Layer 1 reads `navigator.webdriver` directly. We override via init-script + Patchright's `--enable-automation` removal | Likely (industry-standard signal). Init script must override regardless |
| TLS / HTTP-2 fingerprinting at the gate? | Yes for OpenAI's edge — pure Bun gets through CF but is rejected at `/f/conversation` with HTTP-2-layer fingerprinting (403 "Unusual activity") even with valid tokens. Browser-minted hybrid bypasses by sending from Bun (BoringSSL TLS) **with** browser-minted tokens | **Unknown — needs testing.** The chat POST goes to `api.ngc.nvidia.com`, which is a different host and may have a less aggressive edge. Worth a controlled replay test from Bun with browser-minted token + browser cookies |
| Persistent cookies that gate access | `oai-did` + `oai-sc` (anonymous device id + opaque server state). Long-lived (~24h+) | None on the chat endpoint itself — the captcha token IS the auth. The `playground.enabled` killswitch + general site cookies exist but aren't load-bearing |
| Chat body shape | OpenAI-style `messages` array with extra OAI-specific fields (`parent_message_id`, `client_prepare_state`, `system_hints`, …) | Plain OpenAI `ChatCompletion` schema (per the public OpenAPI at `/v2/endpoints/.../spec`) — `messages`, `model`, `temperature`, `top_p`, `max_tokens`, `tools`, `tool_choice`, `stream`, `chat_template_kwargs.thinking` |

---

## How the two SDK boundaries actually look

### ChatGPT — the "main-world breakthrough"

```
Page (parent)                                      Sentinel iframe
  │                                                (/backend-api/sentinel/frame.html)
  │  fetch('/sentinel/<hash>/sdk.js') ──┐           │
  │  (0, eval)(text)  ── SDK lands on   │           │
  │  window.SentinelSDK ────────────────┘           │
  │                                                  │
  │  SentinelSDK.token('next') ── direct call ─►    │
  │     reads navigator/WebGL/screen/__oai_so_*     │
  │     returns {p, t, c, id, flow}                 │
  │  ◄── three tokens                                │
  │                                                  │
  │  Bun fetch /backend-anon/f/conversation         │
  │     headers: cookies + 3 sentinel tokens        │
  │  ────────────────────────────────────────►      │
                                                       OpenAI edge accepts.
```

The SDK exists as a downloadable file, **executes in the same realm as our
init scripts**, and exposes a synchronous-ish API. We never have to
postMessage anything.

### NVIDIA — opaque iframe

```
Page (parent)                              hCaptcha iframe
                                           (newassets.hcaptcha.com/.../hcaptcha.html
                                            #frame=checkbox-invisible)
  React Send handler                          │
  │                                            │
  │  hcaptcha-client.execute(sitekey)          │
  │     (parent helper from NVIDIA's bundle)   │
  │  ──── postMessage 'execute' ──────────►   │
  │                                            │  reads ITS OWN navigator/screen/
  │                                            │  fonts/WebGL inside the iframe
  │                                            │  POST api.hcaptcha.com/getcaptcha/<sitekey>
  │                                            │  body: { sitekey, host, behavioral
  │                                            │          telemetry, … }
  │                                            │  resp: { token: "P1_…", … }
  │  ◄──── postMessage { token } ──────────    │
  │                                            │
  │  React handler stitches token into header  │
  │  POST api.ngc.nvidia.com/v2/predict/...    │
  │      nv-captcha-token: P1_…                │
  │      nv-function-id:   <uuid>              │
  │  ─────────────────────────────────────►   │
                                                  NIM gateway accepts.
```

The SDK is **inside** the iframe. `window.hcaptcha` on the parent is
`undefined`. `iframe.contentWindow.hcaptcha` is blocked by Same-Origin
Policy because `newassets.hcaptcha.com` ≠ `build.nvidia.com`. We never
get a function reference — only the token, after the fact, via
postMessage.

### A note on what "execute" calls look like on the parent

NVIDIA's bundle ships a thin parent-side helper (we have not yet
fingerprinted the exact symbol — see "Open questions" below). It's the
caller of `postMessage({ type: 'execute', siteKey, … })` and the
listener for `{ type: 'response', token }`. Wrapping that helper at the
parent level is feasible (it lives in our reachable realm) and is the
cleanest place to hook for instrumentation. **It is NOT a path to
mint tokens browserlessly** — it just delegates to the iframe — but it
IS the right place to log call timings, capture every minted token, and
control flow (delay submission, batch requests, etc.).

---

## What transfers from the ChatGPT playbook

These are the techniques we already have in the repo (mostly in
[`domains/chatgpt/src/`](../domains/chatgpt/src) and
[`packages/browser/src/remote/cdp-script-control.ts`](../packages/browser/src/remote/cdp-script-control.ts)).
For each, an honest assessment of whether it helps with hCaptcha:

### 1. Init-script persona injection — **transfers, with a twist**

[`buildChatGPTFingerprintScript`](../domains/chatgpt/src/fingerprint-script.ts)
is a 35 KB persona that overrides ~55 navigator/WebGL/screen/font properties
plus the `Function.prototype.toString` masking prelude. It runs in MAIN
world before any page script via
[`CdpScriptControl.registerInitScript`](../packages/browser/src/remote/cdp-script-control.ts).

**The twist:** Chromium auto-propagates main-world init scripts into
**OOPIFs** ([cdp-script-control.ts:14](../packages/browser/src/remote/cdp-script-control.ts)):

> "The script runs in the main world before ANY page or subframe script,
> including in cross-origin iframes (auto-propagated by Chromium)."

Which means the same persona script we install on `build.nvidia.com`
**also runs inside the `newassets.hcaptcha.com` iframe** — patching the
navigator/WebGL/screen surface that hCaptcha's bot detection reads.
That's a real win: even though hCaptcha runs out of our reach, the
fingerprint inputs it reads are still under our control.

What we'd build: `domains/build-nvidia/src/fingerprint-script.ts` — a
re-skinned version of the chatgpt one, tuned for hCaptcha's specific
property reads. The Layer 1 list (navigator, WebGL, screen, fonts,
AudioContext, MouseEvent.screenX, Battery, Connection) is largely the
same; behavioural pre-seeding (`__oai_so_*`) doesn't apply (hCaptcha
uses different counter names internal to the iframe — we'd need to
identify them by capturing+grepping the hCaptcha bundle).

### 2. Fetch-based body capture — **transfers cleanly**

[`CdpScriptControl.captureScripts({urlPattern})`](../packages/browser/src/remote/cdp-script-control.ts)
hooks `Fetch.requestPaused` for arbitrary URL globs. The chatgpt domain
uses it in `'log'` mode for offline analysis. For hCaptcha:

```ts
await control.captureScripts(
  { urlPattern: '*newassets.hcaptcha.com/*' },
  ({ url, body }) => fs.writeFileSync(`/tmp/hcap-${slug(url)}.js`, body)
);
```

Bodies are read but never modified (per the existing chatgpt comment
about Turnstile bundles potentially self-checksumming, which applies to
hCaptcha too — they almost certainly check their own bundle integrity).
Capture-only is the safe baseline. With bodies on disk we can grep for:

- The msgpack encoder used to build the JWT payload
- The `getcaptcha` POST builder (request body shape — telemetry fields)
- The behavioural-counter symbol names (the hCaptcha analogue of
  `__oai_so_kt_count`)
- Self-integrity checks (so we know what NOT to modify)

### 3. Mutate-before-evaluate via `Fetch.fulfillRequest` — **transfers, but high risk**

The infrastructure supports it (`Fetch.fulfillRequest` is a CDP primitive,
the existing capture machinery already pauses requests). What's currently
**not** in `CdpScriptControl` is a public `decorateScript(url, mutator)`
helper — but adding one is a half-day's work.

The hCaptcha bundle is `c6e277da868021789…`-versioned (visible in iframe
URLs), minified, and the version rotates frequently. If hCaptcha
self-checksums (the comment in `fingerprint.ts` notes Turnstile bundles
"XOR-decrypt and may self-check" — hCaptcha is more aggressive about
this), any body modification will be detected and the token rejected
server-side. The chatgpt domain explicitly chose **not** to mutate
bundles for this reason.

**Recommended use:** instrumentation of *non-hCaptcha* scripts only —
specifically NVIDIA's own bundle that wraps the `postMessage` helper.
Mutating NVIDIA's React bundle to log `hcaptcha-client.execute` calls is
much safer than mutating hCaptcha's iframe code, because NVIDIA isn't
hash-checking their own React build at runtime.

### 4. Behavioural pre-seed — **transfers in spirit, needs new schema**

ChatGPT pre-seeds `__oai_so_*` to make first-message-after-page-load
look like 30 seconds of natural interaction. hCaptcha collects similar
signals (mouse path, keystroke timing, focus events) but the property
names live inside the iframe and aren't exposed on `window`.

What we'd need:
- Capture the hCaptcha bundle (technique #2 above), find the symbols
- Either spoof them via init-script (which runs inside the iframe so
  this works) or trigger real synthetic events via Patchright before
  clicking Send

The latter is simpler. Patchright `page.mouse.move(x, y, {steps: 30})`
with realistic Bezier-curve motion is much harder to detect than fake
counter values, and it works without grepping the hCaptcha bundle.

### 5. SDK direct-call (the `(0, eval)` breakthrough) — **does NOT transfer**

This is the load-bearing trick for the chatgpt hybrid. It only works
because Sentinel ships its SDK as a downloadable JS file we can re-eval.

For hCaptcha:
- The actual SDK is bytes inside the iframe — we cannot re-execute them
  in the parent realm without major rewriting (and the SDK self-references
  iframe-only globals like `document.body` of the captcha widget)
- Even if we could, the token-mint flow includes a server round-trip to
  `api.hcaptcha.com/getcaptcha/<sitekey>` whose response binds to the
  iframe's specific session state

**Conclusion:** the chatgpt hybrid pattern in its strict form ("eval SDK
into parent, call directly, replay from Node") is not available for
hCaptcha. The closest analogue is:

### 6. **Frame-evaluate hybrid** (the realistic NVIDIA-side approach)

Patchright exposes `page.frames()` returning all frames including OOPIFs.
`frame.evaluate(fn)` runs in that frame's main world. CDP attaches to
OOPIF targets automatically.

**Hypothesis to test:** `frame.evaluate(() => hcaptcha.execute('<sitekey>'))`
inside the hCaptcha iframe should mint a token, because:
- `window.hcaptcha` IS defined inside the iframe (just not on the parent)
- The iframe doesn't have a `window === window.top` self-check (unlike
  Sentinel's iframe, which does)
- Patchright's CDP attachment to OOPIFs gives us `Runtime.evaluate` in
  the iframe's main world

If this works it's significant — it lets us mint tokens **without driving
the textarea/Send click**. Faster, more reliable, and decouples token
minting from the React UI flow. Worth one experiment.

If it fails, the fallback is the current approach: drive the Send button
and watch the network. We're not better off than today, just no worse.

### 7. Browser-as-token-factory + Node-as-transport — **transfers**

ChatGPT's `sentinelGatedConversation` ([toolkit/chatgpt/routes.ts](../../toolkit/chatgpt/routes.ts))
uses the browser only to mint tokens and harvest cookies, then fires the
conversation POST from Node. For NVIDIA we want the same shape:

```
1. Drive UI / frame-evaluate to obtain nv-captcha-token (P1_...)
2. Read nv-function-id from the spec endpoint (already public, no browser needed)
3. Cancel the browser's outbound chat POST (Fetch.requestPaused → Fetch.failRequest)
4. Reissue from Node with the captured token + Authorization-free headers
5. Stream the response body to the HTTP client as a ReadableStream
```

The benefit is true streaming + transport off the browser thread, NOT
captcha bypass. The browser still has to mint each token. But at least we
don't have to buffer the full SSE body and re-emit it like the current
`browserDrivenChat` does.

---

## Concrete plan for `domains/build-nvidia`

In rough priority order, with effort estimates:

### Phase 1 — Read-only instrumentation (~half a day)

Goal: capture hCaptcha's bundle to disk, observe traffic, prove what we
think we know.

1. **Add a `BuildNvidiaScriptInterceptor`** modelled on
   [`ChatGPTScriptInterceptor`](../domains/chatgpt/src/fingerprint.ts).
   For now: log mode only. Captures bodies for:
   - `*newassets.hcaptcha.com/*` (all hCaptcha bundles)
   - `*api.hcaptcha.com/*` (the getcaptcha endpoint and any siblings)
   - `*build.nvidia.com/_next/static/chunks/*` (NVIDIA's bundle, to find
     the `postMessage` helper)
2. **`POST /api/build-nvidia/debug/script-log/attach`** (idempotent
   attach) and **`GET /api/build-nvidia/debug/script-log`** (SSE stream
   of captured bodies + property reads), mirroring the chatgpt
   `fingerprint/log` route.
3. **One-time controlled tests**:
   - Capture a token, replay it once at +5s, +30s, +60s, +90s, +110s.
     Confirm the "single-use" claim under controlled conditions.
   - Strip the `nv-captcha-token` header on the second request and see
     whether the gateway still accepts it (some sites only require
     captcha on first request per session).
   - Try a Bun fetch with browser-minted token + browser cookies.
     Establish whether `api.ngc.nvidia.com` has the same TLS-fingerprint
     wall as `chatgpt.com` does.

### Phase 2 — Frame-evaluate experiment (~2 hours)

Goal: prove or disprove that we can call `hcaptcha.execute(...)` from
inside the iframe via Patchright's frame API.

1. Add a debug route `POST /api/build-nvidia/debug/mint-from-frame`
   that:
   - Walks `page.frames()` to find the hCaptcha frame
   - `frame.evaluate(fn)` to query `typeof window.hcaptcha` and (if
     defined) call `hcaptcha.execute(siteKey, {async: true})`
   - Returns the token or the error
2. If it works, plumb through to a new
   `POST /chat/completions/browser-fast` route that uses the
   frame-evaluate path instead of UI-driving Send. Expect ~3-5s per
   call vs. ~15-25s for the UI-driven path.

### Phase 3 — Fingerprint persona for hCaptcha (~1 day)

Goal: make build-nvidia's connected browser look as un-bot-like to
hCaptcha as the chatgpt persona makes it look to Sentinel/Turnstile.

1. Build `domains/build-nvidia/src/fingerprint-script.ts` re-skinned
   from chatgpt's. The Layer 1 list overlaps heavily — same navigator,
   WebGL, screen, fonts. Skip the `__oai_so_*` pre-seed. Add
   hCaptcha-specific behavioural seeding once we've identified the
   relevant symbols from Phase 1's bundle capture.
2. Wire it through `BuildNvidiaScriptInterceptor.attach()` →
   `CdpScriptControl.registerInitScript(...)`.
3. Verify by: (a) reading captured property accesses in log mode and
   confirming our values surface, (b) sustained chat throughput without
   visible captcha challenges appearing (the prior session noted the
   profile became "soft-banned" under pressure — a good fingerprint
   should keep the invisible-mode token-issue path in play).

### Phase 4 — Transport hybrid (~half a day)

Goal: move the response transport from the browser to Node for true
streaming. Captcha bypass NOT in scope.

1. In the `/chat/completions/browser` handler, register a
   `Fetch.requestPaused` matcher for the predict POST URL. When it
   fires, capture URL/headers/body, then `Fetch.failRequest` to abort.
2. Reissue from Node with `fetch(url, {headers, body})`. Pipe
   `response.body` directly into a `new Response(stream, …)` returned
   to the HTTP client. SSE chunks reach the caller as they arrive.
3. Keep the buffered fallback behind a query param for one release in
   case the intercept-and-replay introduces edge cases.

### Phase 5 — (Speculative) hCaptcha solver service integration (~1 day, vendor-dependent)

Goal: fully browserless chat completions on the anonymous tier.

This would integrate a third-party hCaptcha solving service (2captcha,
anti-captcha, etc.) — pay-per-solve, ~$0.001/req, latency ~10-30s.
Worth doing only if the bearer-keyed `integrate.api.nvidia.com/v1`
path doesn't suit a particular use case. Not recommended as default
behaviour because it: (a) has a per-request cost, (b) is detectable by
NVIDIA via solver-IP fingerprints, (c) violates hCaptcha's TOS.

---

## What we still don't know

These are the open questions that should drive the next investigation
session, not invisible assumptions in the codebase. Each is roughly
half-an-hour to answer.

1. **Does `frame.evaluate(() => window.hcaptcha)` work on the OOPIF?**
   Industry consensus says yes (Patchright/Playwright frame access works
   across origins). One controlled test confirms it for our specific case.
2. **Does the iframe SDK refuse if we call `hcaptcha.execute` from
   automation?** hCaptcha enterprise has bot-detection paths that
   silently return fail-tokens. We need to actually capture what comes
   back.
3. **Is `nv-captcha-token` truly single-use?** The prior session marked
   it so based on one observation. A controlled replay test (within
   the 120s TTL) would either unlock token-pool amortization or
   close that path definitively.
4. **Does `api.ngc.nvidia.com` TLS-fingerprint?** ChatGPT's edge does;
   NVIDIA may or may not. Controls whether the Phase-4 transport hybrid
   actually works as intended (Bun fetch with a captured token must be
   accepted).
5. **Where exactly does NVIDIA's bundle call hCaptcha?** Currently we know
   it's a `postMessage` round-trip; we don't know the exact wrapping
   function name. Phase 1's bundle capture answers this. Knowing the
   symbol lets us hook it cleanly for instrumentation rather than
   guessing at the React handler.
6. **What's in the `passkey` blob?** Not strictly necessary for any of
   the phases above, but interesting to confirm whether it's pure
   server-side ciphertext or contains client-readable telemetry. Static
   analysis of the captured bundle (Phase 1) would surface this.

---

## Code map

What lands where in the codebase, today and after the plan above:

| Concern | Today | After Phase 4 |
|---|---|---|
| Init script (persona) | Not present for build-nvidia. ChatGPT version: [`domains/chatgpt/src/fingerprint-script.ts`](../domains/chatgpt/src/fingerprint-script.ts) | `domains/build-nvidia/src/fingerprint-script.ts` |
| CDP plumbing (init + Fetch capture) | [`packages/browser/src/remote/cdp-script-control.ts`](../packages/browser/src/remote/cdp-script-control.ts) — already supports both modes | Same. Possibly add `decorateScript(url, mutator)` helper for NVIDIA-bundle instrumentation |
| Persona controller | Not present. ChatGPT version: [`domains/chatgpt/src/fingerprint.ts`](../domains/chatgpt/src/fingerprint.ts) (`ChatGPTScriptInterceptor`) | `domains/build-nvidia/src/fingerprint.ts` (`BuildNvidiaScriptInterceptor`) |
| Browser-driven chat (UI-driving) | [`domains/build-nvidia/src/browser-chat.ts`](../domains/build-nvidia/src/browser-chat.ts) | Kept as fallback for when frame-evaluate fails |
| Frame-evaluate token mint | None | `domains/build-nvidia/src/captcha-frame.ts` (Phase 2) |
| Transport hybrid (Node-side replay of captured request) | None | Adds CDP `Fetch.requestPaused` matcher in route handler (Phase 4) |
| Bearer-token chat passthrough | [`domains/build-nvidia/src/routes.ts`](../domains/build-nvidia/src/routes.ts) (`POST /chat/completions`) | Unchanged. This is the recommended default path |
| Spec endpoint (publishes `nvcfFunctionId`) | [`domains/build-nvidia/src/routes.ts`](../domains/build-nvidia/src/routes.ts) (`GET /models/:vendor/:slug/spec`) | Unchanged |

---

## Live capture findings — 2026-05-02

This section is the source of truth, updated from controlled probes. Earlier
sections describe the *model* — anything below this header is what we
actually observed in a `build-nvidia` Patchright session.

### Phase 2 — frame-evaluate hypothesis: **FALSIFIED**

The doc above hypothesised that `frame.evaluate(() => hcaptcha.execute(...))`
inside the OOPIF would mint a token because hCaptcha (unlike Sentinel)
lacks a `window === window.top` self-check. The first half is correct —
the second isn't.

What we actually found by walking `page.frames()` and evaluating inside
each cross-origin frame:

- `page.frames()` returns 4 frames (main page, an `about:blank`, two
  hCaptcha frames at `newassets.hcaptcha.com/.../hcaptcha.html#frame=...`)
- Frames materialise lazily — `page.frames()` only sees them after the
  user has typed in the textarea. Before then the iframes exist in the
  DOM (`document.querySelectorAll('iframe')` shows 3) but Patchright
  treats them as un-navigated.
- `frame.evaluate` succeeds in both hCaptcha frames (cross-origin doesn't
  block it; CDP attaches to OOPIF targets transparently).
- BUT `Object.keys(window)` inside the iframe contains **only standard
  DOM globals** (`window`, `document`, `navigator`, `localStorage`,
  `postMessage`, `requestAnimationFrame`, `addEventListener`, …) — no
  captcha-related symbols at all. `typeof window.hcaptcha === 'undefined'`
  in both frames.

**The hCaptcha SDK is fully closure-bound inside the iframe.** It deliberately
publishes nothing to the global scope. Direct `hcaptcha.execute(sitekey)`
from `frame.evaluate` is **not** a path. The "main-world breakthrough"
that worked for Sentinel does not transfer.

Code: [`domains/build-nvidia/src/captcha-frame.ts`](../domains/build-nvidia/src/captcha-frame.ts) — kept as a debug surface (probeHCaptchaFrame, mintTokenFromFrame). Routes: `GET /api/build-nvidia/debug/captcha/frame`, `POST /api/build-nvidia/debug/captcha/mint`.

### Phase 2b — postMessage protocol observed

Installing a `window.addEventListener('message', …)` on the parent and
provoking a chat send revealed the real channel between NVIDIA's bundle
and the hCaptcha iframe. Five iframe→parent messages captured during
widget setup:

```text
[0] {source:"hcaptcha", t:"r",  fi:2, i:"<widget-id>"}        — frame ready
[1] {source:"hcaptcha", t:"ri", fi:2, i:"<widget-id>"}        — frame ready-init
[2] {source:"hcaptcha", label:"get-url", id:"<wid>",
                        promise:"create", lookup:"<corr-id>"}  — RPC out
[3] {source:"hcaptcha", label:"challenge-loaded", id:"<wid>"}  — challenge ready
[4] {source:"hcaptcha", label:"site-setup", id:"<wid>",
       contents:{
         ok:{
           features:{ custom_theme:true, enc_get_req:true },
           c:{
             type:"hsw",                          ← challenge type
             req:"<JWT, msgpack payload>"         ← challenge program
           }
         }
       }}
```

**Envelope shape:**
- `source:"hcaptcha"` — sender id
- `t:"<short>"` (single-letter) — lifecycle event (`r`=ready, `ri`=ready-init)
- `label:"<rpc-name>"` — RPC method (`get-url`, `challenge-loaded`,
  `site-setup`, …)
- `id:"<widget-id>"` — instance correlator
- `promise:"create"|"resolve"`, `lookup:"<corr-id>"` — promise lifecycle
  (so the parent can resolve a promise it created)
- `contents:{ ok:{ … } | err:{ … } }` — RPC payload

**Challenge types observed:** `hsw`, `hsj`, `hsl` (from a switch in the
SDK: `["hsw","hsj","hsl"].indexOf(dr.type)`). The current site uses `hsw` —
"hCaptcha solver worker" — a JS-bytecode proof-of-work challenge.

**Implication for instrumentation:** the parent's window is the natural
hook point. We can `window.postMessage = …` proxy on the parent to
record both sides of the protocol — both NVIDIA's bundle calling
`iframe.contentWindow.postMessage({type:'execute',…})` AND the iframe's
token reply coming back.

Code: [`domains/build-nvidia/src/captcha-frame.ts`](../domains/build-nvidia/src/captcha-frame.ts) — `captureHCaptchaPostMessages` + `pollHCaptchaPostMessages`. Routes: `POST /api/build-nvidia/debug/captcha/pm/start`, `GET /pm/poll`.

### Phase 2c — bundle inspection (the user's actual question)

NVIDIA's own React bundle was captured via CDP `Fetch.requestPaused` on
`*build.nvidia.com/_next/static/chunks/*` — 61 chunks, totalling ~7 MB.
The hCaptcha iframe scripts are *not* captured by this hook because
OOPIFs have their own CDP targets and `Fetch.enable` isn't auto-propagated
across them. Workaround: fetch the iframe HTML directly with curl —
since `newassets.hcaptcha.com` is a public CDN, the bundle is just
downloadable.

Code: [`domains/build-nvidia/src/script-capture.ts`](../domains/build-nvidia/src/script-capture.ts). Routes: `POST /api/build-nvidia/debug/bundles/start`, `GET /bundles/list`, `POST /bundles/stop`.

#### What's in NVIDIA's bundle (relevant chunks)

- **`81560-…js`** (~235 KB) — **`@hcaptcha/react-hcaptcha` package**, fully
  visible in minified form. Class with `componentDidMount`, `loadCaptcha`,
  `renderCaptcha`, `execute(t)`, `getResponse`, `getRespKey`, `setData`,
  `reset`, `close`, `handleOnLoad`, `handleSubmit`, `handleExpire`,
  `handleError`, `handleOpen`, `handleClose`, `handleChallengeExpired`,
  `_pendingExecute`. The `_hcaptcha` field is bound from
  `e.window.hcaptcha` once `/1/api.js` has loaded.
- **`73154-…js`** and **`app/layout-…js`** — string `"nv-captcha-token"`
  appears here. These are the chunks that build the chat completion
  fetch and append the captcha header to it.

#### What's in hCaptcha's iframe (the load-bearing find)

The iframe HTML at `newassets.hcaptcha.com/.../hcaptcha.html` is **571 KB
of HTML** containing **one inline `<script>` of 569 KB** with a hash
header at the top:

```js
/* { "version": "1", "hash": "MEUCIAKsn2ZnMMTbGAbnknQcEO7Or2OsOq+FfvYh2kGVwHj4AiEAvob97wQfSEkCSJEqswJ24NkoRE0H1S/VaY7kNmokyhA=" } */
/* https://hcaptcha.com/license */
!function(){"use strict"; … 568,000+ bytes of minified anti-bot stack … }();
```

The `MEUC...` is an **ECDSA signature** of the body. The HTML's CSP
locks the inline script to a SHA256 hash:

```text
Content-Security-Policy: script-src 'self' 'unsafe-eval'
  'sha256-/fWTPIHYIvWVb3kURgtG2vQRzNUl9dueomT2NQw1ygU='
```

So the integrity check is two-tier: ECDSA signature (verifiable
client-side via `crypto.subtle`) and CSP SHA256 (enforced by the
browser). Modifying bytes of *this* script would defeat both.

#### Anti-bot patterns actually observed in the bundle

Where the doc-section "What detection tells defeat naive spoofing"
(chatgpt) lists 7 things, the live hCaptcha bundle is — surprisingly —
**lighter**. Empirically observed via grep on the 569 KB:

| Pattern | Found? | Notes |
|---|---|---|
| `Function.prototype.toString` override | **Yes — but theirs, not as a detector** | Sentry/Raven (their error reporter) saves `t.da = Function.prototype.toString` and replaces it to mask Sentry-wrapped functions. Restored on teardown via `this.da && (Function.prototype.toString = this.da)`. **Collision risk:** our persona script's toString masking from chatgpt's playbook would chain on top of theirs, producing a non-native-looking outer wrapper that an integrity check could spot. |
| `[native code]` literal | **No** | Not as a literal string. Tied to the toString override above. |
| Stack trace inspection (`.stack.split`, regex match against `native`/`eval`/`webpack`) | **Yes** | Inside Raven again — used for breadcrumb capture, not bot detection. The regexes do match `\\[native code\\]` and `chrome-extension` and `webpack`, so they DO see automation tooling URLs in stack frames if errors fire. |
| `navigator.<prop>` plaintext reads | **Just 6**: `userAgent`, `userLanguage`, `language`, `plugins`, `maxTouchPoints`, `msMaxTouchPoints`, `msPointerEnabled` | Far smaller surface than Sentinel's ~55. The heavy lifting is the proof-of-work + image puzzle, not the fingerprint. |
| `navigator.webdriver` literal | **No** | If checked at all it's via obfuscated property lookup. Plain-string matches return zero hits. |
| `cdc_…` / `_phantom` / `selenium` / `puppeteer` / `playwright` / `HeadlessChrome` literals | **None found** | Same caveat — could be obfuscated. |
| `String.fromCharCode` / `atob(` (string obfuscation) | **2 of each** — minimal | The script is genuinely minified, not heavily obfuscated. |
| `window.<prop>` reads | A normal-looking list | `Buffer`, `Element`, `addEventListener`, `atob`, `Raven`, `TextDecoder/Encoder`, `console`, `devicePixelRatio`, `innerWidth`, `parent`, `__wdata`, `_sharedLibs`, `msgpack`, `android`. The `__wdata` is hCaptcha's own data exchange surface; `_sharedLibs` is internal SDK shared state; `android` checks for an Android WebView bridge. None look like bot tells. |
| `window.top` / `window.parent` / `frameElement` / `window.opener` | `window.parent` only | hCaptcha's iframe checks `window.parent` (it's expected to be embedded), not `window.top` like Sentinel. **No "must be top window" gate.** |
| `crypto.subtle`, `importKey`, `HMAC`, `crc32`, `integrity` | **All present** | Confirms server-issued tokens use real crypto (HMAC), and the SDK can verify integrity client-side (used for the ECDSA hash check, presumably). |
| `requestAnimationFrame` + `mousemove` / `mouseup` | **Yes** | Classic behavioural-signal collection. |
| `getContext` (canvas/WebGL fingerprint) | **Yes** | Not as elaborate as Sentinel's `UNMASKED_VENDOR_WEBGL` enums, but it's there. |
| Error reporting to Sentry / Raven | **Yes** | If our injection causes JS errors, they get reported back to hCaptcha. The user's "we can still inspect them" note applies even if the bundle errors out — but each error becomes a server-side telemetry data point. |

#### `getcaptcha` request shape (extracted from the SDK)

```js
url:           ut.endpoint + "/getcaptcha/" + a.sitekey,   // POST
data:          l,                                          // payload (msgpack)
dataType:      o,
responseType:  n,
withCredentials: …,
```

Plus telemetry: `i.gc = e.duration` and `i.gch = (e.name.split("://")[1]||"").split…`
captures the `getcaptcha` round-trip duration and host for inclusion in
the next request's payload. Status codes 429/403/400 are explicitly
handled with `Ut("api:getcaptcha-error-"+(t&&t.status), …)` reports.

#### Challenge types and the JWT

The challenge JWT we partially captured (`c.req` field) is the input to
the SDK's challenge solver. The `type` discriminates:

```js
function Vr(){
  return !(!dr || !fr) &&
    (-1 !== ["hsw","hsj","hsl"].indexOf(dr.type) &&
     (!("n" in fr.payload) || fr.payload.n === dr.type))
}
```

- `hsw` — hCaptcha solver **w**orker (proof-of-work, JS bytecode VM). NVIDIA's invisible-mode default.
- `hsj` — likely **j**igsaw / image puzzle (visible challenge fallback)
- `hsl` — likely **l**ow-friction or label challenge

The `req` JWT carried `{f:0, s:2, t:"w", d:"<base64 ~1.5 KB challenge bytecode>"}`
where `t:"w"` matches `hsw`. The `d` field is the bytecode the in-iframe
VM evaluates to compute the proof.

### Updated transferability assessment

Earlier in this doc the `mutate-before-evaluate via Fetch.fulfillRequest`
section said modifying the hCaptcha iframe bundle is "high risk" because
the bundle "almost certainly self-checksums." This is now **confirmed
empirically**: ECDSA `MEUC` hash header at the top of the inline script
+ browser-enforced CSP `sha256-…` pin. **Bundle byte modification breaks
the iframe before it can run.**

But — the user's instinct that "we can learn a lot without the checksum
passing" holds: even when the modified iframe HTML is rejected by the
CSP, the **first attempt** to load may still emit error telemetry that
tells us *what* check fired and in what order. And the **NVIDIA bundle**
has no such integrity check (it's standard Next.js code), so we can
inject debug logs around `_hcaptcha.execute(...)` calls there freely.

Three concrete next moves implied by these findings:

1. **Persona collision audit.** Before transplanting chatgpt's persona
   script, audit it against hCaptcha's own `Function.prototype.toString`
   override. Either (a) install our overrides BEFORE hCaptcha's so its
   `t.da = Function.prototype.toString` captures *our* override (and
   their masking layer hides ours), or (b) detect their teardown and
   patch above it. Option (a) is simpler — Chromium init scripts run
   before any page script, so our patches will already be installed
   when their `C:` initializer captures `t.da`.

2. **Mutate the NVIDIA bundle, not hCaptcha's.** `81560-…js` (the
   react-hcaptcha component) is the right injection target. Wrapping
   `execute(t)` to log args + stringified return value gives us full
   visibility into the token round-trip without touching anything
   hCaptcha protects. NVIDIA Next.js builds don't self-check.

3. **Capture iframe scripts via OOPIF CDP attachment.** The current
   `CdpScriptControl` is rooted at the parent page's session. To hook
   hCaptcha's iframe scripts via Fetch, we'd need to attach to the
   iframe's CDP target — Patchright exposes this through its target
   tree but our wrapper doesn't expose it as a public surface yet.
   Half-day's work in `cdp-script-control.ts`. Useful if/when we want
   to rebuild the bundle from CDN with cache-busting query params (since
   the inline-in-HTML version is signed, but `js.hcaptcha.com/1/api.js`
   may not be — needs verification).

---

## Live findings — 2026-05-02 evening (E1 + E2)

Targeted experiments to answer "can we run NVIDIA chat completions from pure
Bun fetch with one-time browser warm-up?"

### Setup

- New helpers in [`domains/build-nvidia/src/browser-chat.ts`](../domains/build-nvidia/src/browser-chat.ts):
  - `browserDrivenChatCapture` — drives a chat AND records the predict POST tuple via `page.on('request')`. Used by E1.
  - `captureUnburned` — pre-arms `page.route(predict-url, abort)` so the browser's outgoing POST is aborted at the protocol layer BEFORE leaving the box. Captcha minting still runs (it precedes the POST), so we get the request tuple with a FRESH token that the server has never seen. Used by E2.
- New file [`domains/build-nvidia/src/replay.ts`](../domains/build-nvidia/src/replay.ts) — Bun `fetch()` replay with header allowlist/denylist/overrides + cookie skip, for elimination tests.
- Three debug routes in [`domains/build-nvidia/src/routes.ts`](../domains/build-nvidia/src/routes.ts):
  - `POST /api/build-nvidia/debug/capture-predict` — drive chat, capture tuple (token gets burned by the chat itself).
  - `POST /api/build-nvidia/debug/capture-unburned` — drive captcha mint, abort POST, capture tuple with fresh token.
  - `GET  /api/build-nvidia/debug/last-predict` — inspect captured tuple.
  - `POST /api/build-nvidia/debug/replay-predict` — replay last capture from Bun with header tweaks.

### E1 results (token-burned replay)

| Test | Headers/body | Status | Server msg |
|---|---|---|---|
| Replay captured tuple as-is, immediately | Full headers + cookies | **400** | `"Token is invalid"` |
| Re-replay 2× more back-to-back | Same | 400 / 400 | `"Token is invalid"` |
| Strip `nv-captcha-token` | Drop captcha header | 400 | `"Captcha required"` |
| Strip cookies + Origin + Referer | Token kept | 400 | `"Token is invalid"` |

**Conclusion**: Tokens are **single-use**, server-side validated. Once any client (browser OR Bun) consumes a token, it's "invalid" forever. `nv-captcha-token` is the load-bearing field: without it the server returns the *different* error `"Captcha required"`.

### E2 results (un-burned token replay — the breakthrough)

Captured a fresh token via `captureUnburned` (browser mints, Bun's fetch never sees it) and replayed from Bun.

| Test | Stripped | Status | Conclusion |
|---|---|---|---|
| Full replay | nothing | **200 ✓** | Browser-minted token works from Bun |
| Different prompt body | swap entire `messages` | **200 ✓** | **Token is NOT body-bound** — works for any chat content within TTL |
| Re-replay same token | same call again | 400 | Single-use confirmed |
| Strip all 40 cookies | `skipCookies: true` | **200 ✓** | Cookies NOT required |
| Strip Origin + Referer | `headerDenylist` | **200 ✓** | CORS headers NOT required |
| Strip User-Agent | `headerDenylist` | **200 ✓** | UA NOT required |
| Strip all `sec-ch-ua-*` | `headerDenylist` | **200 ✓** | Client hints NOT required |
| Allowlist `[token, function-id, content-type, accept]` | drop everything else | **200 ✓** | Subset of these 4 is the minimum |
| Allowlist `[token, function-id, content-type]` | drop accept too | **200 ✓** | accept implied; stripped works |
| Allowlist `[token, function-id]` | drop content-type | 415 | content-type required (Bun defaults to text/plain) |

**Minimum required surface for a NVIDIA chat completion POST**:
- `nv-captcha-token: P1_<JWT>` — fresh, single-use, browser-minted
- `nv-function-id: <uuid>` — per-model, public, from `/v2/endpoints/<org>/<model>/spec`
- `content-type: application/json`
- Body: standard OpenAI chat completion JSON (model, messages, stream, …)

**Token is NOT bound to**: body content, cookies, Origin, Referer, User-Agent, sec-ch-ua-*, TLS fingerprint (Bun's BoringSSL TLS differs from Chrome's and still works).

### Architectural implications

The path to truly browserless chat is now clear:

1. **One-time per server lifetime**: Open one warmed browser session.
2. **Per chat completion**: Capture one un-burned token from that session (`captureUnburned`), then send the actual chat from Bun fetch with just 3 headers. No browser per-chat in the data path.
3. **Throughput is bounded by token-mint rate** in the browser, not by request transport. The next experiment (E3) tests how many tokens we can mint per second from one warmed page — if it's > 1 token/sec, we're shipping.

### E3 results (throughput) + production route

Measured token-mint rate from one warmed page after early-bail fix to `captureUnburned` (resolve the moment the request listener fires; don't wait for the never-coming response):

- 5 sequential mints: 5.8s, 2.2s, 2.3s, 1.9s, 1.9s — **~0.35 mints/sec average, ~0.5/sec at steady state.**

Built [`POST /api/build-nvidia/chat/completions/browserless`](../domains/build-nvidia/src/routes.ts) — production hybrid route. Per chat:
1. Mint a fresh unburned token via `captureUnburned` (browser, ~2s).
2. Build the OpenAI-shaped chat completion body using the user's `messages`.
3. POST to NVIDIA's predict endpoint from Bun fetch with just 3 headers (`nv-captcha-token`, `nv-function-id`, `content-type`).
4. Stream the response body straight back to the API caller. True end-to-end SSE — no buffering.

The route abort in `captureUnburned` is racy ~30% of the time (the browser's POST occasionally beats the abort and burns the token). The route auto-retries the mint once on `"Token is invalid"` / `"Captcha required"` errors. 8 sequential calls in production mode: **8/8 success** (3 needed a retry). Average ~4.8s including retry overhead; ~2s when the first mint sticks.

Next: **E4** is now lower priority — the single-page rate is already useful. If we need throughput >1 chat/sec, we'd build the multi-page pool. **E5/E6/E7** (jsdom, addBinding, hsw VM) become "remove the browser entirely" optimizations; the mint-then-replay shape works today.

### E6 results — SDK trap mint (binding path)

Goal: skip the UI drive entirely and call `_hcaptcha.execute(widgetId, {async:true})` directly. Builds on E3.

**The shape of the surface, empirically:**
- `js.hcaptcha.com/1/api.js?onload=hCaptchaOnLoad&render=explicit` IS loaded by NVIDIA's bundle (visible via `performance.getEntriesByType('resource')`), even though no `<script>` tag survives in `document.scripts`.
- The loader calls `window.hcaptcha = { render, execute, getResponse, reset, close, setData, getRespKey, remove }`.
- `@hcaptcha/react-hcaptcha` does `this._hcaptcha = e.window.hcaptcha`, then NVIDIA's bundle (or react-hcaptcha's own teardown — exact site unidentified) makes `window.hcaptcha` `undefined` again before any `page.evaluate` can read it. From an isolated-world perspective `window.hcaptcha` is *never* visible.
- `execute()`'s first arg is the **widget id** (returned by `render()` and exposed on the iframe as `data-hcaptcha-widget-id`), not the sitekey. Passing the sitekey raises `invalid-captcha-id`. NVIDIA's page renders one invisible widget on every model URL.

**The trap, [`domains/build-nvidia/src/sdk-trap.ts`](../domains/build-nvidia/src/sdk-trap.ts):** install a main-world init script that re-defines `window.hcaptcha` as an accessor BEFORE the loader runs. The setter mirrors every assignment to a hidden cache (`_captured`) that survives any later `delete window.hcaptcha`. Exposes `window.__bn_mintToken(idOrSitekey?)` — auto-discovers the widget id from the DOM if the caller passed a sitekey-shape (UUID).

**The Node-side surface:** `CdpScriptControl.evaluateInMainWorld(expr, { awaitPromise: true })` runs `await window.__bn_mintToken(...)` and returns the token string. Wrapped in a per-page mutex because the SDK shares an internal `_pendingExecute` slot.

**Soak (8 sequential `/chat/completions/binding` calls, single page, no UI drive between them):**

| Call | dur | result |
|------|-----|--------|
| 1 | 5746 ms | ok (cold start: persona+trap install, page reload, SDK load) |
| 2 | 1093 ms | ok |
| 3 | 1351 ms | ok |
| 4 | 1088 ms | ok |
| 5 | 1075 ms | ok |
| 6 | 1073 ms | ok |
| 7 | 1140 ms | ok |
| 8 |  999 ms | ok |

**8/8** with no race-loss retries. Mint itself averages ~330 ms; full chat round-trip (mint + Bun fetch + first SSE chunk) ~1100 ms at steady state. **2x faster than `/browserless`** (which sat at ~2s + 30% retry chance) and the failure mode is gone — there is no abortable-but-racy outgoing POST to lose.

**Production:** [`POST /api/build-nvidia/chat/completions/binding`](../domains/build-nvidia/src/routes.ts). Same body shape as `/browserless`; cached `nvcfFunctionId` per model; per-browser-session mint mutex; transparently navigates to the model page if not already there. Browser still required at boot (to render the widget once and capture the SDK ref); per-request transport is pure Bun fetch with three headers.

**What this does NOT solve:** the browser is still load-bearing as a one-time SDK host. **E7** (true browserless, no widget render at all) remains the only meaningful step beyond this — see findings below.

### E7 reconnaissance — reframed (NOT a "bytecode VM in Node")

Captured a real mint via [`hcap-xhr-tap`](../domains/build-nvidia/src/hcap-xhr-tap.ts) — a focused init script that records full request + response bytes for any URL on `*.hcaptcha.com` from the iframe (auto-propagates to OOPIFs; integrity preserved). Findings overturn the bytecode-VM hypothesis from the original plan:

**Each `_hcaptcha.execute()` makes exactly ONE network call:** `POST https://api.hcaptcha.com/getcaptcha/<sitekey>` with `Content-Type: application/octet-stream`. Request ~25 KB, response ~2.5 KB, ~300 ms round-trip. No follow-up `check`/`siteverify`. The server returns the token directly in this response.

**Request body is a 2-element msgpack array:**
- `[0]` — **plaintext JSON** (~700 bytes), the spec from the *previous* call:
  ```json
  {"type":"hsw","req":"<JWT>"}
  ```
  The JWT payload `{f,s,t,d,l,i,e,n,c}`:
  - `t:"w"` matches type `hsw` (proof-of-work)
  - `d` = ~1.5 KB base64 challenge bytecode (changes each call)
  - `l:"/c/d104b9aae0221727…"` = path to the proof JS (stable across calls)
  - `i:"sha256-wXAi/tlOeOQe+p/Tc79B1CsxPV5cQ1jyoI/1m/RrtH8="` = SRI integrity hash for the proof JS
  - `n:"hsw"` = global function name set by the proof JS
  - `c:1000` = challenge difficulty count
  - `e:<unix>` = expiration (bumped each call)
- `[1]` — **encrypted** 24 KB blob (random-looking; site config has `enc_get_req:true`). Holds the fingerprint + motion data + computed proof.

**Response is also encrypted** — first byte `0xf7`, decodes as a stream containing a custom msgpack `ExtType(code=102)` envelope. Not a standard msgpack type — hCaptcha-specific.

**The chained protocol:**
```
mint N:   client POSTs (spec_{N-1}, enc(proof_{N-1} + fingerprint))
          server returns (token_{N-1}, spec_N)  ← both in one response
mint N+1: client POSTs (spec_N, enc(proof_N + fingerprint))
          ...
```

So `execute()` is a single chained round-trip. The proof JS is only fetched + parsed ONCE per session (cached by `Wr` in `inline.js` keyed by `payload.n`). Subsequent mints re-call `window.hsw(prev_d, opts)` synchronously to compute the next proof.

**Why this is harder than the original plan thought:**

The plan called for "reimplement the hsw bytecode VM" — there is no separate VM to reimplement. The proof JS is just code, easily run in Node `vm`. But the actual blocker is **two layers of custom symmetric crypto**:
1. Request item [1] is encrypted with `enc_get_req:true` — key derivation unknown (probably HMAC of sitekey + per-page nonce, possibly ECDH-derived from a server pubkey baked into the bundle).
2. Response wraps with `ExtType(code=102)` — custom envelope, decryption path lives inside `inline.js`.

Reversing both is the gate. Plus we'd need to reimplement the fingerprint + motionData encoder (the bundle has ~70 fields per d4c5d1e0). 2-4 days minimum, high uncertainty.

**Practical conclusion:** the gap from E6 to E7 is substantial reverse engineering of crypto + fingerprint encoding for a marginal benefit (E6 already mints in ~330 ms with a one-time-per-server browser). Recommended pause point unless throughput beyond E6 is needed — at which point **E4 (multi-page parallelism)** is the cheaper next step (linear scale-out via `RemoteBrowserService.getOrCreatePage(id)`, no new reverse engineering).

Captured artifacts on disk for posterity:
- [`/tmp/hcap-xhr-200.bin`](file:///tmp/hcap-xhr-200.bin) — full encrypted response (2491 bytes)
- [`/tmp/hcap-xhr-req.bin`](file:///tmp/hcap-xhr-req.bin) — full request including plaintext spec + encrypted body (25311 bytes)
- [`/tmp/hcap-xhr-req2.bin`](file:///tmp/hcap-xhr-req2.bin) — second mint, for diffing

---

## Reading order if you're new to this

1. Read [`domains/chatgpt/TURNSTILE.md`](../domains/chatgpt/TURNSTILE.md)
   — long but everything in this doc is a delta against it.
2. Skim [`packages/browser/src/remote/cdp-script-control.ts`](../packages/browser/src/remote/cdp-script-control.ts)
   header (lines 1-50) — the load-bearing CDP wrapper.
3. Skim [`domains/chatgpt/src/fingerprint.ts`](../domains/chatgpt/src/fingerprint.ts)
   header — explains the log-vs-control mode pattern we'd mirror.
4. Read [`domains/build-nvidia/src/browser-chat.ts`](../domains/build-nvidia/src/browser-chat.ts)
   in full — it's the current, naive UI-driving baseline we'd be
   improving.
5. Come back here.
