# How Cloudflare Turnstile Gates ChatGPT

A reference for building the chatgpt proxy. Source confidence is labelled per
section — anything not labelled "confirmed" is a working model that should be
re-validated against a live capture before we lean on it.

## TL;DR

- **chatgpt.com is anonymous-accessible.** The conversation API works without
  a logged-in account; an anonymous browser session gets a `device_id` cookie
  + an "anonymous" Bearer token from `/api/auth/session` and that's enough to
  POST to `/backend-api/conversation`.
- **Every conversation request requires a Turnstile challenge token** in the
  `OpenAI-Sentinel-Chat-Requirements-Token` header. The token is minted by a
  bytecode VM running inside a Cloudflare Turnstile iframe, and it encodes a
  fingerprint of the browser environment at the moment the user submits.
- **Two scripts mint the token jointly:** Cloudflare's Turnstile VM (browser
  fingerprint, Layer 1) and OpenAI's Sentinel + Signal Orchestrator (React
  state + behavioural signals, Layer 2/3).
- **Implication for a proxy API:** if the persona we install via init-script
  is consistent across requests, the same persona will produce a
  consistent-looking token sequence — meaning a server-side proxy that pumps
  conversation requests through a long-lived browser session can use a chosen
  fingerprint instead of the host machine's real one.

---

## The Three Layers Sentinel Reads

Source: Buchodi's static analysis of the decrypted Turnstile VM, cross-checked
against inline comments in `domains/chatgpt/src/fingerprint-script.ts`. The
*list of properties per layer* is confirmed; the exact order and hashing
function are working-model.

### Layer 1 — Browser fingerprint (~55 properties)

Read inside the Cloudflare Turnstile iframe (`challenges.cloudflare.com`).
Categories:

| Category | Properties read | Notes |
|---|---|---|
| WebGL | `UNMASKED_VENDOR_WEBGL` (37445), `UNMASKED_RENDERER_WEBGL` (37446), `VERSION` (7938), `SHADING_LANGUAGE_VERSION` (35724), and 4 more `getParameter` enums | Probed via `getContext('webgl')` and `getContext('webgl2')`; also `OffscreenCanvas` |
| Navigator | `platform`, `vendor`, `webdriver`, `languages`, `language`, `hardwareConcurrency`, `deviceMemory`, `maxTouchPoints`, `plugins`, `mimeTypes` | `webdriver` is a strict tell — must be `undefined`, not `false` |
| Screen | `colorDepth`, `pixelDepth`, `width`, `height`, `availWidth`, `availHeight`, `availLeft`, `availTop` | macOS Chrome reports `availTop=36` (menu bar) |
| Fonts | Layout-based font probe — creates a hidden absolute-positioned div, sets `font-family`, calls `getBoundingClientRect()` | Width/height per font fingerprints OS+font collection |
| AudioContext | `sampleRate` (typically 44100) | Default 48000 in some Linux Chromium → fingerprintable |
| Connection | `effectiveType`, `downlink`, `rtt` (if `navigator.connection`) | Not present on Safari |
| Permissions | `notifications` permission state | Headless Chrome exposes this differently |
| MouseEvent | `screenX` / `screenY` on mouse + pointer events | CDP-driven `Input.dispatchMouseEvent` produces `screenX=0,screenY=0`; real users have non-zero offsets |
| Battery | `navigator.getBattery` — present? | macOS Chrome does NOT expose this; Linux/Win do |

**Why ~55 not exactly 55:** Buchodi's count includes individual `getParameter`
enums and individual screen properties as separate slots. The bytecode reads
55 distinct values; we cover all of them in
[`fingerprint-script.ts`](src/fingerprint-script.ts).

### Layer 2 — Behavioural signals (~36 `__oai_so_*` properties)

Read by ChatGPT's Signal Orchestrator (the `oai-so` chunk under
`/_next/static/chunks/`). NOT the same script as Cloudflare Turnstile —
co-resident on the page and feeds the same submission. Properties live on
`window.__oai_so_*` and are populated by event listeners ChatGPT registers
during page hydration:

| Group | Properties | What they measure |
|---|---|---|
| Keystroke | `__oai_so_kt_count`, `__oai_so_kt_last`, `__oai_so_kt_avg` | Count, last timestamp, mean inter-keystroke interval |
| Mouse | `__oai_so_mv_dist`, `__oai_so_mv_vel`, `__oai_so_mv_last` | Total cursor distance, mean velocity, last move timestamp |
| Scroll | `__oai_so_sc_count`, `__oai_so_sc_dist` | Wheel events + cumulative pixels |
| Idle | `__oai_so_idle_ms` | Time since last input |
| Activity | `__oai_so_paste`, `__oai_so_click` | Counts |

The remaining ~25 of the 36 are sub-keys (window/document/event combinations
inside the same buckets) — we pre-seed the high-signal ones in
`buildChatGPTFingerprintScript`.

**Why pre-seed:** A fresh-tab fingerprint that submits a message at t=200ms
with `__oai_so_kt_count = 5` and `__oai_so_idle_ms = 50` is an obvious bot —
no human types 5 chars in 50ms. We seed realistic values up front so a
proxy-driven session looks like it's been running for ~30s of natural
interaction before the first message goes out.

### Layer 3 — React internals (3 properties)

Sentinel walks the React fiber tree to confirm the page genuinely rendered
the ChatGPT SPA:

- `__reactRouterContext` — present iff React Router v6 hydrated
- `loaderData` — present iff the route loader resolved
- `clientBootstrap` — set by ChatGPT's SSR-hydration glue

If any of these are missing, the token is rejected server-side regardless of
how good Layer 1/2 look. **A bot that spoofs the browser fingerprint but
doesn't render the actual ChatGPT React app will fail.**

This is the *load-bearing reason* the proxy uses a real Patchright browser
session instead of pure header-replay. We can spoof Layer 1+2 in JS, but
Layer 3 requires the actual React tree to exist.

---

## How Token Minting Works

Source: Buchodi article + observed network traffic. **Working model — needs
re-validation against a captured token.**

```
1. Browser receives Turnstile widget code (encrypted bytecode + a `p` token).
2. Bytecode is XOR-decrypted with `p` at runtime, producing a small VM image.
3. The VM walks the property list (Layers 1–3 above), reading each value.
4. The VM hashes the collected values (likely a streaming XOR + folding;
   Buchodi did not fully document the hash).
5. The hash is wrapped in the Turnstile envelope along with site-key, time
   bucket, and an HMAC over the assembled payload.
6. Cloudflare server-side verifies signature + freshness; OpenAI server-side
   gates the `/backend-api/conversation` POST on the resulting token via the
   `OpenAI-Sentinel-Chat-Requirements-Token` header.
```

Tokens are short-lived (seconds) and one-shot per message. The Turnstile
iframe re-mints on every conversation submission — meaning **fingerprint
inputs read at submit-time, not at page-load time**. This is why behavioural
signals matter: the values at the *moment of submit* are what go into the
token.

---

## Anonymous-User Flow

This is the path the proxy actually takes. Confirmed via observed traffic on
the existing `domains/chatgpt` plugin.

```
1. Browser navigates to https://chatgpt.com/
2. ChatGPT hydrates; assigns a `device_id` cookie if none present.
3. Browser fetches /api/auth/session
   → returns { accessToken: "<anon-token>", expires, user: null }
   → the accessToken is the anonymous-user Bearer.
4. User types a message and clicks send.
5. ChatGPT requests a Turnstile challenge inline; Sentinel + Turnstile
   collaborate to mint the OpenAI-Sentinel-Chat-Requirements-Token.
6. ChatGPT POSTs /backend-api/conversation with:
     Authorization: Bearer <anon-token>
     OpenAI-Sentinel-Chat-Requirements-Token: <minted-token>
     Content-Type: application/json
     <conversation payload>
7. Server streams an SSE response.
```

**Why the proxy works at all:** steps 5+6 happen in the live browser session
the proxy owns. We don't have to re-mint the Sentinel token from scratch
server-side — we just have the browser do it for us, and our `browserFetch`
forwards the result.

---

## What Detection Tells Defeat Naive Spoofing

Working model — these are the patterns Sentinel/Turnstile look for, based on
public Cloudflare bot-management docs + Buchodi:

1. **`navigator.webdriver` truthy.** `--enable-automation` flag sets this.
   Patchright's `ignoreDefaultArgs: ['--enable-automation']` removes it. Our
   baseline init script also defines a `webdriver: () => undefined` getter as
   belt-and-braces.
2. **`HeadlessChrome` substring in `User-Agent` or `sec-ch-ua`.** Headless
   Chromium's default UA leaks this. Replaced via `userAgent` and explicit
   `sec-ch-ua` headers in `FingerprintController`.
3. **WebGL vendor "Google Inc." with renderer "ANGLE (...)".** SwiftShader
   and headless GPU stacks produce telltale renderer strings. We override
   to a realistic Apple/Intel pair.
4. **`MouseEvent.screenX === 0`.** CDP `Input.dispatchMouseEvent` defaults
   `screenX/screenY` to 0. Real users have non-zero (window position offset).
   We patch via `MouseEvent.prototype.screenX` getter to add a randomised
   offset (`screenOffsetX`, `screenOffsetY` in `FingerprintProfile`).
5. **`Function.prototype.toString` on a spoofed getter returns the source
   instead of `[native code]`.** Sentinel's introspection includes
   `Object.getOwnPropertyDescriptor(navigator, 'platform').get.toString()`.
   We patch `Function.prototype.toString` with a Proxy + WeakMap of
   "fake natives" so our installed getters report
   `function get platform() { [native code] }`. See the hardening prelude in
   `buildFingerprintScript`.
6. **Layer-3 React internals missing.** A pure JS environment (jsdom etc.)
   never produces these. Hard-required to render the actual ChatGPT SPA.
7. **`__oai_so_*` values missing or impossibly low.** A first-message-at-page-
   load with `__oai_so_idle_ms === 0` and `__oai_so_kt_count === 0` is
   trivially detectable. We pre-seed plausible values.

---

## Open Questions (Things We Don't Know Yet)

These are the gaps a proxy-API author should resolve before relying on a
specific approach. Capture-and-decrypt work is needed to answer each.

1. **Does the Turnstile bundle self-checksum?** If yes, modifying the script
   bytes via `Fetch.fulfillRequest` will fail silently (token rejected
   server-side). Current proxy explicitly does NOT modify bytes — but we
   don't actually know whether the previous prepend-preamble approach was
   working or just looked like it was working. Capture a token mint from a
   modified vs unmodified bundle and compare server acceptance.
2. **Does the VM read fingerprint values via `Reflect.get` or direct
   property access?** `defineProperty` getters defeat direct access. They do
   NOT defeat `Reflect.get(navigator, 'platform', somethingNotNavigator)` if
   the VM caches a prototype reference. Static analysis of the bytecode would
   confirm.
3. **What is the hash function?** Without knowing this we can't synthesise
   tokens server-side; we have to round-trip every request through the live
   browser. Acceptable for low-volume, expensive at scale.
4. **What's the TTL on a minted token?** Empirically a few seconds. If it's
   exactly N seconds we can pre-mint slightly ahead of submission and reduce
   per-request latency.
5. **Does the anonymous Bearer rotate?** We've observed it lasting ~24h. If
   it rotates per device-id, we may need to re-call `/api/auth/session` at a
   shorter cadence than the current 20h refresh.

---

## Code Map

How the model above lands in the codebase:

| Concern | File |
|---|---|
| 55-property persona script (Layers 1+2) | `src/fingerprint-script.ts` → `buildChatGPTFingerprintScript` |
| Hardening prelude + post-pass (toString masking, log buffer) | same file, IIFE prelude |
| CDP plumbing for init-script install + Fetch capture | `packages/browser/src/remote/cdp-script-control.ts` |
| Persona attach / mode switch / log channel | `src/fingerprint.ts` → `ChatGPTScriptInterceptor` |
| Anonymous-Bearer harvest from `/api/auth/session` | `src/session.ts` → `ChatGPTSessionManager` |
| Conversation proxy that forwards `Authorization` + `OpenAI-Sentinel-Chat-Requirements-Token` | `src/routes.ts` → `POST /chat`, `POST /v1/chat/completions` |

## References

- Buchodi, *"ChatGPT Won't Let You Type Until Cloudflare Reads Your React State — I Decrypted the Program That Does It."* (https://www.buchodi.com/chatgpt-wont-let-you-type-until-cloudflare-reads-your-react-state-i-decrypted-the-program-that-does-it/)
- Cloudflare Turnstile docs (public-facing): https://developers.cloudflare.com/turnstile/
- ChatGPT NextAuth `/api/auth/session` shape: observed traffic; not officially documented.

---

## Live Capture Findings — 2026-05-01

Captured against `chatgpt.com` from a fresh Chromium session with **no
account login**, via `./scripts/connect-browser.sh --profile chatgpt-rev`
+ `/browser/traffic`. The architecture differs from the model above in
several material ways. **Use this section as the source of truth** for
the anonymous flow until further capture work updates it.

### TL;DR — what's actually gating anonymous messages

OpenAI runs **its own** Sentinel system at `/backend-api/sentinel/*` and
`/backend-anon/sentinel/*`. **That**, not Cloudflare Turnstile, is the
primary gate on anonymous messages. The Buchodi article describes a
Cloudflare-specific model that may apply to logged-in flows but does
NOT match the anonymous flow we observe. Cloudflare's
`cdn-cgi/challenge-platform` does fire (one telemetry POST), but it
isn't the message gate.

### The actual anonymous request chain

```
User opens chatgpt.com (no login)
  ↓
Cookies set: oai-did=<uuid>, oai-sc=<opaque ~270B blob>
  ↓
GET /backend-anon/me                          → identity stub (no email)
GET /backend-anon/accounts/check/...          → account props
GET /backend-anon/models                      → model list (gpt-5-3 etc)
GET /backend-anon/system_hints                → UI hints
DOCUMENT /backend-api/sentinel/frame.html     → loads Sentinel iframe
POST /cdn-cgi/challenge-platform/h/g/jsd/oneshot/...
                                              → Cloudflare bot telemetry
                                              (one-shot, not a gate)
  ↓
User types a message and clicks send
  ↓
POST /backend-anon/sentinel/chat-requirements/prepare
     req:  (cookies only — NO Authorization header)
     resp: { persona: "chatgpt-noauth",
             prepare_token: "gAAAAA<~66 KB Fernet blob>" }
  ↓
(Sentinel JS in the iframe runs the challenge program — reads the
 fingerprint values, drives the prepare_token's embedded JS challenge.)
  ↓
POST /backend-anon/sentinel/chat-requirements/finalize
     resp: { persona: "chatgpt-noauth",
             token:   "gAAAAA<Fernet blob — the gate-pass>" }
  ↓
POST /backend-anon/f/conversation/prepare     → { conduit_token: <JWT> }
POST /backend-anon/f/conversation
     req:  { action: "next", messages: […], parent_message_id:
             "client-created-root", model: "auto" }
           — NO Authorization, NO sentinel header
     resp: SSE stream — `event: delta` × N, `data: [DONE]`
  ↓
(Heartbeat continues throughout the session:)
POST /backend-anon/sentinel/ping              → { status: "OK" }
POST /backend-api/sentinel/req                req: { p: "gAAAAA..." }
                                              resp: { token: "gAAAAA..." }
```

### Three things we got wrong above

1. **The `OpenAI-Sentinel-Chat-Requirements-Token` header is not used in
   the anonymous flow.** No request in the captured trace carries that
   header. The gate state is held server-side, keyed by cookies +
   `prepare_token` lifecycle.
2. **There is no Authorization Bearer for anonymous users.** Auth is
   purely cookie-based (`oai-did` + `oai-sc`). The 20-hour
   `ChatGPTSessionManager.needsHarvest()` threshold and the
   `/api/auth/session` polling in `session.ts` apply to **logged-in
   sessions only** — they're inactive code on the anonymous path.
3. **The conversation endpoint is `/backend-anon/f/conversation`** (note
   the `/f/` segment + `model: "auto"` field), not
   `/backend-api/conversation`. The proxy's `routes.ts` currently posts
   to the latter. Anonymous users will get 401/403 on the existing
   `/api/chatgpt/chat` route until it's switched to the anonymous path.

### What `gAAAAA…` is

Three distinct Fernet-encoded tokens flow through the system:

| Token | Source | Carried in | Likely contents (encrypted) |
|---|---|---|---|
| `prepare_token` | `chat-requirements/prepare` response | response body | the JS challenge program for the iframe to execute |
| Sentinel pass-`token` | `chat-requirements/finalize` response | response body | the gate-pass that authorises N messages from this device |
| `p` blob | client → `/backend-api/sentinel/req` | request body | fingerprint + behavioural state report (heartbeat) |

`gAAAAA` is the standard Fernet (`cryptography.fernet`) header: version
byte `0x80`, then a Unix-timestamp + IV + ciphertext + HMAC. **The
plaintext is not recoverable client-side without the server's symmetric
key.** This is a hard wall for any "synthesise tokens server-side"
approach — the proxy must round-trip through the live browser to get
real tokens.

### Implications for the proxy API

- **The current `/api/chatgpt/chat` route is targeting the wrong
  endpoint for anonymous use.** It needs an `/api/chatgpt/anon-chat`
  variant (or a flag) that POSTs to `/backend-anon/f/conversation`,
  uses cookie-only auth, and uses `model: "auto"` instead of
  `model: "gpt-4o"`.
- **No Bearer harvest is needed for anonymous use.** The browser
  already has `oai-did` + `oai-sc` cookies after the first page load;
  `browserFetch` carries them automatically.
- **No `OpenAI-Sentinel-Chat-Requirements-Token` injection is needed.**
  The Sentinel handshake happens client-side inside the page's own
  Sentinel iframe; the proxy just submits the conversation request and
  the server validates the gate by cookie + session state.
- **The fingerprint script we install via `CdpScriptControl` is still
  the right tool** — Sentinel's `p`-blob fingerprint payload is built
  from the same kind of `navigator` / WebGL / behavioural reads
  documented above. The Layer 1/2/3 model is mostly correct; the
  encryption envelope and endpoint URLs are the parts that changed.

### Re-scoping the Five Open Questions

Given the above, the original Q1–Q5 list needs adjustment before
deeper investigation:

| Original Q | Status under the live model | Re-scope |
|---|---|---|
| **Q1** Self-checksum on Turnstile bundle | Likely answerable instead on the **OpenAI Sentinel** JS bundle (`/backend-api/sentinel/frame.html` + chunks). Cloudflare Turnstile bundle is fire-and-forget; modifying it has no token to invalidate. | Pivot to: does modifying the **Sentinel** JS body (the script that builds the `p` blob) cause server rejection on the next `/sentinel/req` POST? |
| **Q2** `defineProperty` vs `Reflect.get` | Still valid; Sentinel reads the same fingerprint properties. The probe methodology is unchanged. | No change. |
| **Q3** Hash function | Replaced by: **what's the symmetric-key derivation for the Fernet envelope?** If client-side (e.g. derived from `oai-sc` cookie + a JS constant), we can decrypt and read `p` directly. If server-only, we can't. | Pivot. |
| **Q4** Token TTL | The token to test is now the Sentinel **pass-token** from `finalize` (or the per-request `p` token from `/sentinel/req`'s response). Re-scoped methodology applies cleanly. | Adjust target token. |
| **Q5** Anonymous Bearer rotation | **N/A — there is no Bearer for anonymous users.** The 20-hour refresh in `ChatGPTSessionManager` applies only to logged-in sessions, which we don't have a profile for. | Close as N/A; investigate cookie (`oai-sc`) rotation cadence instead if the proxy author cares. |

### Capture Artefacts

This finding is reproducible. The full traffic dump used to derive the
table above is at `/tmp/traffic-q.json` on the workstation that ran
the capture. To reproduce:

```bash
./scripts/connect-browser.sh --profile chatgpt-rev --url https://chatgpt.com --port 3001
sleep 12  # let page hydrate
curl -s -X POST http://localhost:3001/browser/traffic/clear
# In the browser: type a message and click send.
sleep 15
curl -s http://localhost:3001/browser/traffic > /tmp/traffic-anon.json
```

Then grep `/tmp/traffic-anon.json` for `backend-anon`, `backend-api`,
and `sentinel` URLs.

---

## Priority-1 Investigation Findings — 2026-05-01

We spent ~3 hours testing whether the anonymous flow could be reproduced
in pure **Bun** (no Patchright browser). Pure-Bun is blocked at the
conversation gate by protocol-layer fingerprinting (see "The 403 wall"
below). The **hybrid Priority-1** that ultimately shipped — browser
mints per-message tokens via the page's own SDK, Bun does the fetch —
is documented under "Priority 1 — Hybrid SHIPPED" further down.

### The Cloudflare wall is real but not the hard one

`cf-mitigated: challenge` blocks Node 24 fetch and curl on the very
first POST to a `/backend-anon/sentinel/*` endpoint. **Bun bypasses
Cloudflare** because Bun uses BoringSSL (the TLS library Chrome
itself uses), so its TLS ClientHello fingerprint matches Chrome
closely enough that CF's JA3/JA4 matcher lets it through. No
TLS-mimicry library required at the CF gate.

### `gAAAAA…` is fake Fernet, not real Fernet

The `gAAAAA…` envelope **looks** like cryptography.fernet output
because of the leading `0x80` version byte, but it isn't. The
client-side construction is just string concatenation:

    p_blob       = "gAAAAAC" + base64(JSON.stringify(fingerprint_array))
    proof_blob   = "gAAAAAB" + base64(JSON.stringify(proof_array))    + "~S"
    turnstile    = XOR-encoded short blob (separate scheme)

No symmetric encryption is performed client-side. The server-issued
tokens (`prepare_token`, pass-`token`) ARE real Fernet, with a key
only the server holds — those we can't synthesise.

### The fingerprint array (24 fields) — full schema

Captured from a real `/sentinel/chat-requirements/prepare` body:

```
[
  1600,                                              // [0] composed viewport metric (probably innerHeight + scrollY)
  "Fri May 01 2026 19:57:14 GMT-0400 (Eastern Daylight Time)",  // [1] new Date().toString()
  4294967296,                                        // [2] performance.memory.jsHeapSizeLimit
  1,                                                 // [3] visibility / iframe boolean
  "Mozilla/5.0 ... Chrome/145.0.0.0 Safari/537.36",  // [4] navigator.userAgent
  "https://www.googletagmanager.com/gtag/js?id=G-9SHBSK2D9J",  // [5] last-loaded script URL
  "prod-e72ce87e983a564c22178e7872785a3f094cfdff",  // [6] data-build hash from <html>
  "en-US",                                           // [7] navigator.language
  "en-US",                                           // [8] navigator.languages[0]
  0.19999992847442627,                              // [9] math fingerprint (close to Math.tan(11) result)
  "createAuctionNonce−function createAuctionNonce() { [native code] }",  // [10] random-pick navigator method + toString
  "_reactListeningmprv9gz2w9",                       // [11] random-pick __reactListening* key from document
  "toolbar",                                         // [12] random window event name
  42608.5,                                           // [13] performance.now() snapshot
  "20d2721f-83a8-4948-992e-5068f6177721b",          // [14] react fiber render UUID
  "",                                                // [15] empty string
  8,                                                 // [16] navigator.hardwareConcurrency
  1777680688299.1,                                  // [17] performance.timeOrigin (fractional ms)
  0,                                                 // [18] kt_count (keystrokes)
  0,                                                 // [19] mv_dist (mouse distance)
  0,                                                 // [20] mv_vel (mouse velocity)
  0,                                                 // [21] sc_count (scrolls)
  0,                                                 // [22] idle_ms
  0,                                                 // [23] click_count
  0                                                  // [24] padding / reserved
]
```

The trailing zeros at [18-24] are the `__oai_so_*` behavioural counters.
The `proofofwork` array has the same shape but with non-zero values at
[3] and [9] (PoW iteration counts).

### The full required envelope

Headers required on every `/backend-anon/*` request:

```
OAI-Language:           en-US
OAI-Device-Id:          <oai-did cookie value>
OAI-Client-Version:     prod-e72ce87e983a564c22178e7872785a3f094cfdff
OAI-Client-Build-Number: 6311184
OAI-Session-Id:         <random UUID per session>
```

Additional headers on `/f/conversation` (the actual message POST):

```
X-OpenAI-Target-Path:                       /backend-api/f/conversation
X-OpenAI-Target-Route:                      /backend-api/f/conversation
OAI-Echo-Logs:                              0,<5-digit-counter>
OAI-Telemetry:                              [1,null]
OpenAI-Sentinel-Chat-Requirements-Token:    <pass-token from finalize>
OpenAI-Sentinel-Proof-Token:                gAAAAAB<base64-proof>~S
OpenAI-Sentinel-Turnstile-Token:            <XOR-encoded short blob>
x-oai-turn-trace-id:                        <random UUID per turn>
```

The three `OpenAI-Sentinel-*-Token` headers are **per-message**: the
SDK regenerates them on every submit. They sit alongside the longer-
lived pass-token; without them the server returns 403 even with a
valid pass-token.

### Body shapes

**`/sentinel/chat-requirements/prepare`:**
```json
{ "p": "gAAAAAC<base64-fingerprint-array>" }
```

**`/sentinel/chat-requirements/finalize`:**
```json
{
  "prepare_token": "gAAAAA<from prepare response>",
  "proofofwork":   "gAAAAAB<base64-proof-array>~S",
  "turnstile":     "<XOR-encoded short blob>"
}
```

**`/f/conversation/prepare`:**
```json
{
  "action": "next",
  "fork_from_shared_post": false,
  "parent_message_id": "client-created-root",
  "model": "auto",
  "client_prepare_state": "none",
  "timezone_offset_min": 240,
  "timezone": "America/New_York",
  "conversation_mode": { "kind": "primary_assistant" },
  "system_hints": [],
  "partial_query": {
    "id": "<uuid>", "author": { "role": "user" },
    "content": { "content_type": "text", "parts": ["<message>"] }
  },
  "supports_buffering": true,
  "supported_encodings": ["v1"],
  "client_contextual_info": { "app_name": "chatgpt.com" }
}
```

**`/f/conversation`:** uses `messages` array (not `partial_query`),
adds `client_prepare_state: "sent"`, `enable_message_followups: true`,
`client_contextual_info` with full screen/viewport metrics, plus
`no_auth_ad_preferences`, `paragen_cot_summary_display_override`,
`force_parallel_switch`. See
`experiments/q-priority1/anon-client.ts` for the exact shape.

### What's NOT used (red herrings — save your time)

- **`Authorization: Bearer …`** — anonymous flow has no Bearer.
- **`/api/auth/session`** — returns only a warning banner for
  anonymous users. The existing
  [`session.ts`](src/session.ts) `ChatGPTSessionManager` is
  inactive on this path.
- **`client-correlated-secret` HS512 JWK in localStorage** — imported
  via `crypto.subtle.importKey` 4× on page load and used in 2 verify
  calls (returning `false`), then never touched. Does NOT sign the
  conversation. Probably for analytics auth.
- **`Function.prototype.toString` patches in
  [`fingerprint-script.ts`](src/fingerprint-script.ts)** — the SDK does
  not introspect getter source on the hostile path we observed.
- **`/backend-api/sentinel/req`** — fires *after* the conversation
  submit in our anon trace. Heartbeat / telemetry, not a per-request
  gate.

### The 403 wall — protocol-layer fingerprinting

Pure Bun gets through `prepare`, `finalize`, `f/conversation/prepare`
(all 200), then hits **403 "Unusual activity has been detected from
your device"** on `f/conversation` itself. Tested:

- Adding all observed headers verbatim ✗
- Adding `OAI-Echo-Logs`, `OAI-Telemetry`, `X-OpenAI-Target-*` ✗
- Adding all three `OpenAI-Sentinel-*-Token` headers verbatim from a
  successful browser submit ✗
- Behavioural counters in `p` ✗
- Multiple `/sentinel/req` heartbeats before submit ✗
- Live-session cookie replay (same cookies as the working browser) ✗

**The differentiator must be at HTTP/2 SETTINGS frame, header
pseudo-header order, or OpenAI-edge TLS fingerprinting beyond
Cloudflare's check.** The browser sends bytes that pass; Bun sends
the same application-layer bytes that fail.

To get past this gate from outside a real browser would require
something like `curl-impersonate-chrome` — a TLS+HTTP/2 stack that's
byte-identical to Chrome. That's a multi-hour project on its own and
breaks every time Chrome ships a new version.

### Conclusion

Anonymous flow architecture is fully understood. Three viable
implementations, in order of how they actually shipped:

1. **Hybrid (Priority 1) — SHIPPED.** Browser mints per-message
   Sentinel tokens via the page's own SDK; Bun does the actual
   `/backend-anon/f/conversation` POST. Bypasses both the Cloudflare
   wall (Bun's BoringSSL TLS) AND the OpenAI protocol-fingerprint wall
   (the browser-minted tokens carry the proof Sentinel needs). See
   "Priority 1 — Hybrid SHIPPED" below.
2. **Browser-as-HTTP-client (Priority 2) — also shipped.** Keep
   Patchright's Chromium running, route conversation requests via the
   browser itself. Slower per request than the hybrid but doesn't
   need the SDK eval shim.
3. **Pure Bun, no browser** — still blocked at the protocol-fingerprint
   wall. Would need `curl-impersonate-chrome` or equivalent.

The Layer 1/2/3 fingerprint model from Buchodi's article is correct
in spirit — those properties ARE what gets read into the `p` blob —
but the Cloudflare-Turnstile-as-the-gate framing is wrong for the
anonymous flow. The actual gate is OpenAI's own Sentinel + a
protocol-fingerprint layer.

---

## Priority 2 — Browser-driven proxy SHIPPED 2026-05-01

The working anonymous proxy is at `POST /api/chatgpt/chat` and
`POST /api/chatgpt/v1/chat/completions` (OpenAI-compatible). Both
return real SSE streams from a fresh anonymous chatgpt.com session.
Implementation: `domains/chatgpt/src/routes.ts` + `openai-adapter.ts`.

**How it works.** The browser is the HTTP client. The Node side
drives the UI (type message into composer, click send button) so
the page's SDK regenerates the per-message Sentinel tokens we can't
fake from Bun. We tee the streaming response and forward to the
caller.

The five "gotchas" that took the most iteration to figure out:

1. **Hook in main world, type in isolated world.** Patchright's
   `page.evaluate` runs in an isolated world; the SDK's `fetch`
   runs in main world. So a fetch hook installed via `page.evaluate`
   never sees the SDK's calls — install via `CdpScriptControl
   .evaluateInMainWorld`. But `document.execCommand('insertText')`
   only inserts text reliably from the *isolated* world; main-world
   insertion gets reverted by React. So hooks go through main,
   typing goes through isolated.
2. **`tee()` not `clone()`.** The SDK aborts the response stream
   when rendering completes; that abort propagates through `clone()`
   and breaks our capture. `Response.body.tee()` gives an
   independent reader the SDK can't kill.
3. **Poll a DOM attribute, don't await a promise.** Cross-context
   promise resolution through `Runtime.evaluate {awaitPromise: true}`
   was unreliable. Writing the captured payload to
   `document.documentElement.dataset` and polling from Node side
   works every time.
4. **`delta_encoding: "v1"` is the current SSE format.** Each
   `data:` line is a JSON Patch op (`{p, o, v}`) on a working doc,
   not a cumulative full-text-so-far event. Both the legacy and v1
   formats are handled in `openai-adapter.ts` (`extractFinalText`,
   `toOpenAIChunks`, `applyPatch`).
5. **SDK chunks the conversation submission across multiple JS
   layers.** The actual `fetch` for `/backend-anon/f/conversation`
   runs from a wrapper at `chatgpt.com:159:11` which itself is
   called from a chunk loaded by the React app. Hooks on `window
   .fetch` catch it; hooks on individual chunks would miss it.

**To verify it's still working** (assumes API server at :3001 and a
browser session connected to chatgpt.com):

```bash
curl -sN -X POST http://localhost:3001/api/chatgpt/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Reply with one word: pong"}' --max-time 90
```

Expected: an SSE stream containing `"role": "assistant"`,
`"parts": ["pong"]` (or similar), and ending with `data: [DONE]`.

---

## Priority 1 — Hybrid SHIPPED 2026-05-01

After Priority 2 was working, we revisited Priority 1 and found a
hybrid that bypasses both walls:

- **Cloudflare wall** — Bun's BoringSSL TLS already passes it.
- **OpenAI protocol-fingerprint wall** — bypassed by minting the three
  per-message Sentinel tokens *inside the live page*, then sending the
  conversation request from Bun with those tokens as headers.

The minted tokens carry enough proof of "this came from a real ChatGPT
page" that OpenAI's edge accepts the Bun-originated POST. No
`curl-impersonate-chrome` needed.

### The breakthrough — `(0, eval)(sdk.js)` in the parent page

The Sentinel SDK lives at `/sentinel/<build-hash>/sdk.js`. By default
ChatGPT only loads it inside the `/backend-api/sentinel/frame.html`
iframe — and `SentinelSDK.token()` refuses to run from inside that
iframe (it checks `window === window.top`). So calling the SDK from
the iframe is impossible, and the parent page never loads it.

The fix: load it into the parent page ourselves.

```ts
await evaluate(`(async () => {
  if (window.SentinelSDK) return;
  const r = await fetch('/sentinel/<build-hash>/sdk.js');
  const text = await r.text();
  (0, eval)(text);  // indirect eval → global scope, binds SentinelSDK
})()`);
```

The `(0, eval)(...)` pattern is the trick. Direct `eval(text)` runs in
the calling function's local scope and the SDK's `window.SentinelSDK
= …` assignment doesn't escape. **Indirect** eval (any expression that
isn't the literal identifier `eval`) runs at global scope, so the SDK's
top-level assignments land on `window`.

Once `SentinelSDK` is bound on the parent, calling
`window.SentinelSDK.token('next')` returns a JSON string:

```json
{
  "p": "gAAAAAC<base64-fingerprint>",
  "t": "<turnstile XOR blob>",
  "c": "<chat-requirements pass-token>",
  "id": "<flow id>",
  "flow": "next"
}
```

These three tokens (`p`, `t`, `c`) are the exact values Sentinel's
real submit path puts in the `OpenAI-Sentinel-Proof-Token`,
`-Turnstile-Token`, and `-Chat-Requirements-Token` headers. They're
tied to the page's cookies + `oai-did` but not to any TLS/HTTP-2
property — so a Bun fetch carrying the same cookies and tokens is
accepted.

**Validation:** all five flow names tested (`chat-requirements`,
`next`, `conversation`, `submit`, `test-key`) — every one produced
fresh, accepted tokens. Bun fetch to `/backend-anon/f/conversation`
returns 200 + SSE within ~9s. See
[`experiments/q-priority1/hybrid-test.ts`](experiments/q-priority1/hybrid-test.ts).

### Implementation

- [`src/routes.ts`](src/routes.ts) — `sentinelGatedConversation()` is
  the helper. Loads SDK if needed, mints tokens, fires Bun fetch with
  full header envelope. Used by both `POST /chat` and the OpenAI
  adapter.
- [`src/openai-adapter.ts`](src/openai-adapter.ts) — translates
  OpenAI Chat Completions JSON ⇄ ChatGPT's anonymous SSE shape. Used
  by `POST /v1/chat/completions`.

### The SSE format had a third event shape we missed

ChatGPT's `delta_encoding: "v1"` SSE stream emits JSON Patch ops, but
across THREE shapes — not two:

```text
event 1 (explicit):   data: {"p": "/message/content/parts/0", "o": "append", "v": "Hello"}
event 2 (batch):      data: {"o": "patch", "v": [{...}, {...}, {...}]}
event 3 (shorthand):  data: {"v": " world"}    ← reuses last (p, o)
```

The shorthand event was the source of a long debugging session — the
parser was correctly handling explicit + batch, but ~90% of the
streamed body comes through as shorthand, which we were dropping.
Fix: track `lastPath` + `lastOp` across the loop and replay shorthand
events as `{p: lastPath, o: lastOp, v}`. Code in
[`src/openai-adapter.ts`](src/openai-adapter.ts) — `applyPatch` +
the SSE consumer.

Without the shorthand handler, code blocks emitted by the model arrive
with their content stripped — we'd see opening/closing fences but no
inner lines. With it, full code passes through cleanly.

### Validated against a coding-challenge harness

[`challenges/run.ts`](challenges/run.ts) drives the OpenAI-compatible
`/v1/chat/completions` endpoint through three programming tasks,
extracts the code block, runs the test suite. Results from a clean
anonymous session:

| Challenge | Pass rate | Notes |
| --- | --- | --- |
| 1 — SQLite window functions (Node + better-sqlite3) | **12/12** | Clean pass |
| 2 — Hono WebSocket echo server (Bun) | 0/7 | Server-returns-500 — LLM output quality, not pipeline |
| 3 — Python CSV reporter | 4/5 | Format mismatch on one test — LLM output quality |

**The pipeline works end-to-end.** Failures on challenges 2/3 are
LLM-side (the anonymous tier auto-downgrades to `gpt-5-3-mini` after
the first turn, which struggles with longer multi-step tasks). The
proxy itself shipped real, runnable code through to a passing test
suite for challenge 1.

### Caveats / known limits of the hybrid

- **Anonymous-tier model auto-downgrade.** First message gets a
  better model (`auto` resolves to a `gpt-5` variant); subsequent
  messages on the same session downgrade to `gpt-5-3-mini`. The
  proxy is single-turn per call (no server-side memory), so every
  call gets the first-message model — but quality varies.
- **No conversation threading.** Each `/chat` call mints fresh
  tokens and starts from `parent_message_id: "client-created-root"`.
  If the caller wants multi-turn, it has to send the full history in
  the `messages` array.
- **No tool-calling / function-calling.** Anonymous ChatGPT doesn't
  expose those — clients that rely on strict OpenAI tool mode
  (CrewAI default, etc.) will fail; clients that fall back to
  text-pattern parsing (Aider, OpenHands) work fine.
- **Web search trigger** — the SDK and conversation endpoint accept
  `system_hints: ["search"]` and the model does search if the prompt
  signals it. Citations come back inside `message.metadata.search_result_groups`
  in the SSE patches; the current adapter doesn't surface them
  (drops on the floor). Adding a passthrough for `extra_body.search`
  and capturing `search_result_groups` is ~30 min of work in
  `openai-adapter.ts`.
