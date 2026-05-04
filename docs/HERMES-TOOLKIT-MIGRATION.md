# Hermes-shaped toolkit migration — handoff for the next agent

**Audience:** an agent or engineer who will execute the move from `/Users/adamsohn/Projects/intercept2/domains/build-nvidia/` into `/Users/adamsohn/Projects/toolkit/` and stand up a unified `/v1` API for Hermes to consume.

**Mission, one paragraph:** Hermes needs one OpenAI-compatible API surface that fronts both `chatgpt.com` and `build.nvidia.com`. Today, intercept2 has a working `build-nvidia` plugin with a rich `/v1/{models,chat/completions,mint,raw}` surface (commits `64a9292`, `7df9750`). Toolkit already has `chatgpt` exposing `/api/chatgpt/v1/{models,chat/completions}`. We're going to (a) copy `build-nvidia` into toolkit as `nvidia/`, (b) add a top-level `/v1` dispatcher that merges both providers, (c) provider-prefix the model IDs so dispatch is a string-split, and (d) keep both per-provider namespaces working for back-compat. Token-mint portability to AWS Lambda is already proven for nvidia (verified 2026-05-03, see [`domains/build-nvidia/API.md`](../domains/build-nvidia/API.md)) — the same pattern transfers to chatgpt's Sentinel tokens.

## Read this first

- [`/Users/adamsohn/Projects/intercept2/domains/build-nvidia/API.md`](../domains/build-nvidia/API.md) — the contract we're propagating to toolkit
- [`/Users/adamsohn/Projects/intercept2/domains/build-nvidia/src/model-metadata.ts`](../domains/build-nvidia/src/model-metadata.ts) — the metadata-enrichment module Hermes leans on
- `/Users/adamsohn/Projects/toolkit/server.ts` — current toolkit entry point
- `/Users/adamsohn/Projects/toolkit/chatgpt/openai-adapter.ts` — chatgpt's existing `/v1` surface (lines 450-end)
- `/Users/adamsohn/Projects/toolkit/.claude/CLAUDE.md` — toolkit conventions (notably: don't say "kill")

## Target architecture

```text
                   toolkit/v1 dispatcher (Hermes-facing)
                                 │
                ┌────────────────┴────────────────┐
                ▼                                 ▼
    /v1/models?provider=chatgpt        /v1/chat/completions
    /v1/models?modality=chat           ── parses model_id, dispatches
    /v1/models?capability=tool_calling
    /v1/mint                                     │
    /v1/raw/:provider/:vendor/:slug              │
                                                 ▼
                                      provider plugin layer
                ┌────────────────────────┴────────────────────────┐
                ▼                                                  ▼
        toolkit/chatgpt/                                  toolkit/nvidia/
        ├── /api/chatgpt/v1/...   (kept as-is)            ├── /api/nvidia/v1/...
        ├── chatgpt/<model>                               ├── nvidia/<vendor>/<slug>
        └── Sentinel mint                                 └── hCaptcha SDK-binding mint
                ▼                                                  ▼
        chatgpt.com                                       build.nvidia.com
```

The unified `/v1` dispatcher is the only thing Hermes calls. It uses `model_id.split('/')[0]` to pick the provider, then forwards to the per-provider plugin. Both per-provider `/api/<provider>/v1/` namespaces stay in place — useful for debugging and for clients that want to pin to one provider.

## Model ID convention (load-bearing)

`<provider>/<vendor>/<slug>` — three segments, predictable, sortable.

| Provider | Pattern | Examples |
| --- | --- | --- |
| chatgpt | `chatgpt/openai/<model>` | `chatgpt/openai/gpt-4o`, `chatgpt/openai/o1` |
| nvidia | `nvidia/<vendor>/<slug>` | `nvidia/openai/gpt-oss-20b`, `nvidia/qwen/qwen-image` |

Hermes splits on `/` to know what to do. Both providers MUST emit this shape from their `/v1/models` and accept it on `/v1/chat/completions`. Bare `<vendor>/<slug>` continues to be accepted as a back-compat shortcut — provider defaults to whatever owns the route.

For chatgpt, the second segment is always `openai` (chatgpt.com only serves OpenAI models). For nvidia, the second segment varies (`openai`, `qwen`, `deepseek-ai`, etc.).

## Plan — 8 steps

Each step has a clear exit condition. Don't move on until you can demonstrate the exit condition holds.

### 1. Copy `build-nvidia` source into toolkit

Source files to copy from intercept2 into `toolkit/nvidia/`:

```
domains/build-nvidia/src/captcha-frame.ts        → toolkit/nvidia/captcha-frame.ts
domains/build-nvidia/src/wasm-import-tap.ts      → toolkit/nvidia/wasm-import-tap.ts
domains/build-nvidia/src/routes.ts               → toolkit/nvidia/routes.ts
domains/build-nvidia/src/model-metadata.ts       → toolkit/nvidia/model-metadata.ts
domains/build-nvidia/src/browser-chat.ts         → toolkit/nvidia/browser-chat.ts
domains/build-nvidia/src/replay.ts               → toolkit/nvidia/replay.ts
domains/build-nvidia/src/fingerprint-script.ts   → toolkit/nvidia/fingerprint-script.ts
domains/build-nvidia/src/fingerprint.ts          → toolkit/nvidia/fingerprint.ts (if present, else from chatgpt analog)
domains/build-nvidia/src/sdk-trap.ts             → toolkit/nvidia/sdk-trap.ts
domains/build-nvidia/src/warm-mint.ts            → toolkit/nvidia/warm-mint.ts
domains/build-nvidia/src/warm-pool.ts            → toolkit/nvidia/warm-pool.ts
domains/build-nvidia/src/index.ts                → toolkit/nvidia/index.ts
domains/build-nvidia/src/config.ts               → toolkit/nvidia/config.ts
domains/build-nvidia/src/interceptor.ts          → toolkit/nvidia/interceptor.ts
domains/build-nvidia/API.md                      → toolkit/nvidia/API.md
domains/build-nvidia/lambda-smoke/               → toolkit/nvidia/lambda-smoke/
```

**Path rewrites required.** The intercept2 imports use workspace package names; toolkit uses relative paths:

| intercept2 import | toolkit import |
| --- | --- |
| `@interceptor/browser/handler/domain-loader` | `../browser/handler/domain-loader` |
| `@interceptor/browser/remote` | `../browser/remote` |
| `@interceptor/shared` | (no equivalent — replace `rateLimitedFetch` with `fetch` and `DEBUG` with `console.log` or a tiny shim) |
| `@interceptor/browser/shared/config` | `../browser/shared/config` |

A `sed` pass over all copied files handles ~95% of these. Hand-fix the `@interceptor/shared` calls — toolkit doesn't have a shared package, so either inline the helpers or create `toolkit/nvidia/shared.ts` with `DEBUG = console.log` and `rateLimitedFetch = fetch`. Check `toolkit/chatgpt/` for how it handles the same problem; if `chatgpt` already has analogs, reuse them.

**Exit:** `bun run --filter toolkit/nvidia tsc --noEmit` passes (or whatever the toolkit type-check command is). The copied module compiles.

### 2. Wire `nvidia` into `toolkit/server.ts`

Add alongside the chatgpt mount:

```ts
import { plugin as nvidia } from './nvidia';
// ...
app.route('/api/nvidia', createDomainProxy('nvidia', nvidia.routes ?? [], () => pool.pick()));
console.log(`[toolkit] NVIDIA base URL: http://localhost:${server.port}/api/nvidia/v1`);
```

The `pool.pick()` may need an nvidia-specific persona (chatgpt has its own `personaAttacher`). Decision point: do you want one shared pool (one browser serves both providers, navigates between domains per request) or a separate nvidia pool (lighter, simpler, but more memory)? Recommend starting with **one shared pool, navigate per request** — see "Provider asymmetries" below for the tradeoff.

**Exit:** `curl http://localhost:3001/api/nvidia/v1/models` returns the catalog (49+ chat models). Run a chat completion against `nvidia/openai/gpt-oss-20b` end-to-end. The Lambda smoke harness at `toolkit/nvidia/lambda-smoke/` runs unchanged (it points at the API base URL).

### 3. Provider-prefix the chatgpt model IDs

Edit `toolkit/chatgpt/openai-adapter.ts`'s `/v1/models` handler — emit IDs like `chatgpt/openai/gpt-4o` instead of `gpt-4o`. The handler is at lines ~450-475.

In `/v1/chat/completions`, accept both forms (full + bare). Mirror the pattern from `domains/build-nvidia/src/model-metadata.ts::parseModelId()` — copy that helper into a shared location (suggested: `toolkit/v1/model-id.ts` — see step 5).

**Exit:** `curl http://localhost:3001/api/chatgpt/v1/models | jq '.data[].id'` returns `chatgpt/openai/gpt-4o`-shaped strings. `POST /api/chatgpt/v1/chat/completions` works with both `chatgpt/openai/gpt-4o` and the legacy `gpt-4o`.

### 4. Enrich the chatgpt `/v1/models` shape

Match the shape `domains/build-nvidia/src/model-metadata.ts::EnrichedModel` produces. For chatgpt's static list of 6 models, this is hand-curated metadata — it's fine, just be consistent.

Each entry should have at minimum:

```json
{
  "id": "chatgpt/openai/gpt-4o",
  "provider": "chatgpt",
  "vendor": "openai",
  "slug": "gpt-4o",
  "display_name": "GPT-4o",
  "modality": "chat",
  "capabilities": { "streaming": true, "tool_calling": false, "vision": true, ... },
  "parameters": { /* CHAT_PARAMETERS from model-metadata.ts */ },
  "endpoints": { "chat": "/v1/chat/completions", "mint": "/v1/mint" },
  "object": "model",
  "created": 1699000000,
  "owned_by": "openai"
}
```

The `parameters` shape is critical — Hermes uses it to validate inputs before calling. Don't ship empty objects.

**Exit:** `curl http://localhost:3001/api/chatgpt/v1/models` shape-matches `curl http://localhost:3001/api/nvidia/v1/models`. A diff of one entry per provider should show only the values differing, not the keys.

### 5. Build the unified `/v1` dispatcher

Create `toolkit/v1/`:

```
toolkit/v1/
├── index.ts              — exports the Hono router
├── model-id.ts           — parseModelId() shared by all routes
├── models.ts             — GET /v1/models (merges chatgpt + nvidia catalogs)
├── chat.ts               — POST /v1/chat/completions (dispatches by ID prefix)
├── mint.ts               — POST /v1/mint (dispatches by ID prefix)
└── raw.ts                — POST /v1/raw/:provider/:vendor/:slug (passthrough)
```

`models.ts` calls each provider's `/api/<provider>/v1/models` internally and concatenates `data` arrays. Filtering (`?provider=`, `?modality=`, `?capability=`) happens at the dispatcher layer.

`chat.ts`, `mint.ts`, `raw.ts` parse `model_id`, look up `provider`, forward to the matching `/api/<provider>/v1/...` route. They do **not** re-implement the mint or chat logic — they're thin proxies.

Mount in `server.ts`:

```ts
import { v1 } from './v1';
app.route('/v1', v1);
console.log(`[toolkit] Hermes base URL: http://localhost:${server.port}/v1`);
```

**Exit:** `curl http://localhost:3001/v1/models | jq '.data | length'` returns chatgpt + nvidia model count combined. `POST /v1/chat/completions` with `model=chatgpt/openai/gpt-4o` succeeds. Same with `model=nvidia/openai/gpt-oss-20b`. `POST /v1/mint` returns a chatgpt-shaped bundle for chatgpt models and an nvidia-shaped bundle for nvidia models.

### 6. End-to-end test from the OpenAI Python SDK

Hermes will use `from openai import OpenAI`. Verify the surface holds up:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3001/v1", api_key="not-needed")

# Discovery
models = client.models.list()
print(len(models.data), "models")
chatgpt_models = [m for m in models.data if m.id.startswith("chatgpt/")]
nvidia_models = [m for m in models.data if m.id.startswith("nvidia/")]
assert chatgpt_models and nvidia_models

# chatgpt
r1 = client.chat.completions.create(
    model="chatgpt/openai/gpt-4o",
    messages=[{"role": "user", "content": "Just say PONG"}],
)
assert "PONG" in r1.choices[0].message.content.upper()

# nvidia
r2 = client.chat.completions.create(
    model="nvidia/openai/gpt-oss-20b",
    messages=[{"role": "user", "content": "Just say PONG"}],
    max_tokens=300,
)
assert "PONG" in r2.choices[0].message.content.upper()
```

**Exit:** both calls succeed without modifying any client code beyond the model ID. Streaming works for both. Make this a checked-in script at `toolkit/scripts/smoke-hermes.py` so it's runnable on demand.

### 7. Lambda portability — both providers

Nvidia's mint-then-call is already verified on AWS Lambda. Confirm chatgpt's bundle is similarly portable:

- chatgpt's mint primitive is the Sentinel token (`p,t,c` headers) plus the `oai-did` cookie.
- Decision point: does chatgpt's `/v1/mint` (which doesn't exist yet — you'll add it) return `{url, headers, cookie, expires_at, sample_body, curl_example}`?
- Cookie portability: nvidia needs zero cookies. chatgpt MIGHT need `oai-did`. Investigate by running the same `lambda-smoke/`-style harness against chatgpt — invoke from a Lambda IP, see if Sentinel + cookie is enough or if there's IP-binding.

This step is research-shaped. Time-box it. If chatgpt tokens turn out to be IP-bound, document it and ship `/v1/mint` for nvidia only initially.

**Exit:** `domains/build-nvidia/lambda-smoke/`-equivalent under `toolkit/scripts/lambda-smoke/` runs both `--provider=nvidia --n=4` and `--provider=chatgpt --n=4` and reports per-provider acceptance rates from a Lambda IP.

### 8. Document and pin

Update `toolkit/README.md` with:

- The new `/v1/...` Hermes-facing surface
- The two per-provider `/api/<provider>/v1/...` legacy surfaces (back-compat note)
- The model-ID convention
- Lambda mint-then-call pattern (lift from `domains/build-nvidia/API.md`)
- The smoke script paths

Tag the toolkit version at this point so Hermes integrators have a stable git ref.

**Exit:** `toolkit/README.md` is the only doc Hermes integrators need to read.

## Provider asymmetries to handle

The two providers are NOT symmetric in a few important ways. The dispatcher pattern hides most of these from Hermes, but the harness agent has to handle them in the per-provider plugins.

| Concern | chatgpt | nvidia |
| --- | --- | --- |
| Models | 6 (static list) | ~49 chat-shaped, ~16 preview, others (image, embedding, video) |
| Captcha system | Cloudflare Turnstile / Sentinel SDK | hCaptcha (`P1_`-prefixed token) |
| Mint primitive | `SentinelSDK.token('next')` → `{p, t, c}` headers | `_hcaptcha.execute(sitekey)` → `nv-captcha-token` |
| Cookie dependency | `oai-did` (per-device) probably required | None — verified zero-cookie replay from Lambda |
| Per-device rate limit | Yes, by `oai-did` | Per-IP only (NVIDIA infra) |
| Browser pool | Multiple profiles for fan-out (already implemented) | Currently single browser, no fan-out yet |
| Page navigation per request | Stays on `chatgpt.com/` | Must navigate to `build.nvidia.com/<vendor>/<slug>` |
| Modalities supported via `/v1` | chat only | chat + (image / video / embedding via `/v1/raw`) |
| Streaming format | OpenAI SSE (already adapted) | OpenAI SSE (NVIDIA emits this natively) |
| Mint cost | ~? ms (measure) | ~330 ms (SDK binding) |
| Token TTL | ? (measure) | ~120 s (verified) |

Two specific gotchas:

1. **Page navigation in nvidia**. Each nvidia chat call needs the page on `build.nvidia.com/<vendor>/<slug>` to get the right hCaptcha widget for the model. If the harness uses one shared pool with chatgpt, nvidia requests must navigate before minting and chatgpt requests must navigate back. Cost: page load + waitFor widget = ~3-4s on cold pages. Recommendation: keep one pool but cache "page is currently on URL X" so consecutive requests to the same model skip navigation. Or: separate pools per provider.

2. **`/v1/raw` works for nvidia chat-shaped models but NOT for image/video**. The image-gen playground pages don't render the same hCaptcha widget the SDK trap waits for, so the mint times out. Hermes will need to know which models are reachable through which endpoint — the `endpoints` field in the model metadata is the source of truth. For now, image / video / non-chat nvidia models should be flagged with `endpoints: { mint: "/v1/mint" }` and `Hermes should call /v1/mint then make the upstream request itself`. Adding per-modality mint flows (driving the right page UI per modality) is a follow-up workstream.

## What NOT to do

- Don't merge the per-provider plugins. Each plugin owns its own captcha, fingerprint persona, and mint flow — these have nothing in common at the implementation level. The dispatcher merges them at the API surface, that's enough.
- Don't pre-mint tokens and stash them. Mints expire (~120s for nvidia). Just-in-time minting per request keeps things simple and avoids a whole class of TTL bugs.
- Don't expose the private `/api/<provider>/debug/*` routes through `/v1`. Those are debug-only and assume direct access to the underlying browser.
- Don't try to OpenAI-shape nvidia's image / video / embedding models in this pass. `/v1/raw` is the escape hatch; ship that, defer modality-specific OpenAI shapes (`/v1/images/generations`, `/v1/embeddings`) until a Hermes user actually needs them.
- Don't break the per-provider `/api/<provider>/v1/...` namespaces. They're still useful for debugging and direct integration.
- Don't say "kill" anywhere in code or docs. Toolkit convention: stop / end / halt / terminate / abort. (See `toolkit/.claude/CLAUDE.md`.)

## Verification protocol — the "is this done" checklist

Run these on a freshly-cloned toolkit checkout. If any fail, the migration isn't done.

```bash
cd /Users/adamsohn/Projects/toolkit

# 1. Type-check passes
bun run tsc --noEmit

# 2. Server boots cleanly
bun run start &
sleep 14
curl -sf http://localhost:3001/health | jq .ok    # → true

# 3. Both per-provider surfaces work
curl -sf http://localhost:3001/api/chatgpt/v1/models | jq '.data | length'    # → 6+
curl -sf http://localhost:3001/api/nvidia/v1/models  | jq '.data | length'    # → 30+

# 4. Unified surface merges them
curl -sf http://localhost:3001/v1/models | jq '.data | length'                 # → sum of above
curl -sf 'http://localhost:3001/v1/models?provider=nvidia' | jq '.data | length' # → nvidia only

# 5. Hermes-shaped end-to-end
python toolkit/scripts/smoke-hermes.py    # exits 0

# 6. Lambda portability
node toolkit/scripts/lambda-smoke/driver.mjs --provider nvidia --n 4
# → 4/4 status=200 from Lambda IP
```

Once all six commands pass clean, the migration is done. Tag the commit and update `toolkit/README.md` with the tag.

## Open questions (decision points for the harness agent)

These are real choices, not hidden gotchas. Pick one path and document why.

1. **One shared browser pool or two?** Shared = simpler, ~3-4s nav penalty when switching providers. Two = more memory, faster per-request but more moving parts. Recommend shared at startup; revisit if latency hurts.
2. **Where does `parseModelId` live?** Recommend `toolkit/v1/model-id.ts` and import from there in both plugins. Don't duplicate it.
3. **Should the unified `/v1/models` always merge, or default to `?provider=` if the caller specifies?** Recommend: always merge by default, filter on `?provider=`. Hermes can always filter on its end too.
4. **chatgpt's `/v1/mint`**: ship in this migration or defer? If chatgpt's tokens turn out to be cookie-bound (likely) or IP-bound (possible), `/v1/mint` only makes sense after that's investigated. Recommend deferring to step 7's research — don't block the rest of the migration on it.
5. **Image / video models**: include in default `/v1/models` output or hide? Recommend hide by default (filter to chat + vision), expose via `?modality=image` or `?all=1`. Keeps Hermes from accidentally selecting a model it can't call through `/v1/chat/completions`.

## Reference: what's already proven

Don't re-verify these — they're settled:

- **Token portability to Lambda (nvidia):** mint locally → bundle ships JSON → Lambda hits NVIDIA upstream → 200 with real chat completion. 4/4 success in `us-east-1`. The token is not IP-bound, not cookie-bound, not TLS-fingerprint-bound. Detail: [`domains/build-nvidia/API.md`](../domains/build-nvidia/API.md) under "Cross-machine portability".
- **SDK-binding mint reliability:** ~330ms per mint, no UI driving, no abort race. Replaces the older `captureUnburned` flow which had a 100% burn race on this profile.
- **Bare-vs-prefixed model IDs in body**: NVIDIA's predict endpoint validates `body.model` and only accepts bare `<vendor>/<slug>` (`openai/gpt-oss-20b`), NOT the provider-prefixed form. This is encoded in the `/v1/mint` `sample_body` and `curl_example` fields — pass them through unmodified.
- **msgpack ext type 0x12** for hCaptcha's `/getcaptcha` (not bin). This was the actual blocker the team had been chasing as a fingerprint problem — it's settled in `wasm-import-tap.ts`. Don't change.
