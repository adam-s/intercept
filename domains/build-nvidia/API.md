# build-nvidia API

OpenAI-compatible proxy for free anonymous models on `build.nvidia.com`. No API keys; the server mints fresh hCaptcha tokens per request via a connected Patchright browser.

Designed for Hermes-style agents and unifies cleanly with a future `/api/chatgpt` peer at the toolkit-level `/v1` dispatcher.

## Base URL

```
http://<server>/api/build-nvidia
```

When deployed alongside `chatgpt` in the toolkit, the unified surface lives at `<server>/v1`. The endpoints below are also reachable directly under each plugin namespace.

## Model IDs

`<provider>/<vendor>/<slug>` — three segments, predictable, sortable.

```
nvidia/openai/gpt-oss-20b
nvidia/deepseek-ai/deepseek-v3_1-terminus
nvidia/qwen/qwen-image
```

Bare `<vendor>/<slug>` is also accepted as a back-compat shortcut (provider defaults to `nvidia`).

## Endpoints

```
GET  /v1/models                              List + filter
GET  /v1/models/:provider/:vendor/:slug      One model, full metadata
GET  /v1/models/:provider/:vendor/:slug/queue  Live queue depth + function status

POST /v1/chat/completions                    OpenAI chat (streaming + non-streaming, vision, tools)
POST /v1/mint                                Token bundle for remote runtimes
POST /v1/raw/:provider/:vendor/:slug         Modality-agnostic passthrough
POST /v1/files                               Upload an image / audio asset

GET  /v1/blueprints                          NVIDIA blueprints (filter by ?model=)
GET  /v1/tools/blocklist                     Tool names hidden by the playground
GET  /v1/legal/:id                           TOS / model-license markdown
```

### `GET /v1/models`

Filters (all optional, combinable):

- `?provider=nvidia` — single provider
- `?modality=chat` — `chat | image | embedding | video | audio_speech | audio_transcription | vision | safety | biology | retrieval`
- `?capability=tool_calling` — repeatable, AND-combined
- `?preview=1` — only preview-tier models
- `?all=1` — disable the default chat-only filter

Default returns chat + vision models with `guestAccess: true`.

Each entry:

```json
{
  "id": "nvidia/openai/gpt-oss-20b",
  "provider": "nvidia",
  "vendor": "openai",
  "slug": "gpt-oss-20b",
  "display_name": "gpt-oss-20b",
  "description": "...",
  "modality": "chat",
  "capabilities": {
    "streaming": true,
    "tool_calling": false,
    "reasoning": true,
    "vision": false,
    "json_mode": false,
    "multilingual": false,
    "long_context": false,
    "coding": false,
    "guest_access": true,
    "preview": false
  },
  "parameters": {
    "temperature":      { "type": "number",  "default": 1, "min": 0, "max": 2 },
    "top_p":            { "type": "number",  "default": 1, "min": 0, "max": 1 },
    "max_tokens":       { "type": "integer", "default": 4096, "min": 1, "max": 16384 },
    "presence_penalty": { "type": "number",  "default": 0, "min": -2, "max": 2 },
    "frequency_penalty":{ "type": "number",  "default": 0, "min": -2, "max": 2 },
    "stream":           { "type": "boolean", "default": true },
    "reasoning_effort": { "type": "string",  "default": "medium", "enum": ["low","medium","high"] }
  },
  "endpoints": { "chat": "/v1/chat/completions", "mint": "/v1/mint", "raw": "/v1/raw" },
  "tags": ["chat", "reasoning"],
  "object": "model",
  "created": 1741234567,
  "owned_by": "openai"
}
```

The OpenAI fields (`object`, `created`, `owned_by`) keep `client.models.list()` from the openai SDK working as-is.

### `POST /v1/chat/completions`

OpenAI-shaped, drop-in for the openai SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3001/api/build-nvidia/v1", api_key="not-needed")
r = client.chat.completions.create(
    model="nvidia/openai/gpt-oss-20b",
    messages=[{"role": "user", "content": "Say PONG"}],
)
print(r.choices[0].message.content)
```

Both streaming (`stream=True`) and non-streaming work. Each request mints a fresh hCaptcha token via the SDK-binding path (~330ms), then ships the chat completion via Bun fetch with three headers.

#### Vision

Pass OpenAI multipart `content` arrays with `image_url` parts and the route handles asset upload + body translation automatically. Both `data:` URLs and `http(s):` URLs work:

```python
r = client.chat.completions.create(
    model="nvidia/meta/llama-3.2-11b-vision-instruct",
    messages=[{"role": "user", "content": [
        {"type": "text", "text": "What's in this image?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBOR..."}},
    ]}],
)
```

Each image triggers `POST /v2/nvcf/assets` (one captcha mint) + a presigned-S3 PUT, then the message content is rewritten to NVIDIA's inline form `<img src="data:<ct>;asset_id,<UUID>" />` and the chat request gains `nvcf-function-asset-ids` + `nvcf-input-asset-references` headers. To pre-upload an asset and reference it in multiple chats, see `POST /v1/files`.

#### Tool calling

`tools`, `tool_choice`, and `parallel_tool_calls` are forwarded verbatim. Streamed `tool_calls` deltas are aggregated in the non-streaming path and emerge as a complete `tool_calls` array on the assistant message with `finish_reason: "tool_calls"`:

```python
r = client.chat.completions.create(
    model="nvidia/qwen/qwen3.5-122b-a10b",
    messages=[{"role": "user", "content": "What's the weather in Tokyo?"}],
    tools=[{"type": "function", "function": {
        "name": "get_weather", "description": "...",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
    }}],
    tool_choice="auto",
)
print(r.choices[0].message.tool_calls)
```

Some models on NVIDIA's gateway accept `tools` even when their published OpenAPI spec doesn't declare it (the gateway is more permissive). If your client wants to stay on the safe side, hit `GET /v1/tools/blocklist` first to filter your tool definitions to the playground's allowlist.

### `POST /v1/files`

Upload an image / audio asset to NVIDIA's NVCF asset store. Returns the asset UUID (the `id`); reference it in chat content via the inline `<img src="data:<ct>;asset_id,<UUID>" />` form, and forward it via `nvcf-function-asset-ids`. Two body shapes are accepted:

```bash
# 1. Raw bytes (preferred — no base64 overhead)
curl -X POST http://localhost:3001/api/build-nvidia/v1/files \
  -H 'content-type: image/png' \
  -H 'x-asset-description: cat-photo' \
  --data-binary @cat.png

# 2. JSON with base64 (for clients that can't ship raw bodies)
curl -X POST http://localhost:3001/api/build-nvidia/v1/files \
  -H 'content-type: application/json' \
  -d '{"data":"iVBORw0KGgoA...","content_type":"image/png","description":"cat-photo"}'
```

Returns:

```json
{
  "id": "98f2d868-990e-49b2-b7b0-8239a6a389f2",
  "object": "file",
  "bytes": 70,
  "content_type": "image/png",
  "description": "cat-photo",
  "expires_at": 1777988711,
  "created_at": 1777986611
}
```

The S3 presigned URL backing the asset expires in ~35 min (`expires_at` reflects this). For most use cases you don't need this route — `/v1/chat/completions` uploads automatically when you pass OpenAI multipart `image_url` parts. Use `/v1/files` only when you want to upload once and reference the same asset across multiple chat calls.

### `GET /v1/models/:provider/:vendor/:slug/queue`

Live queue / function status for a model — useful for liveness probing without burning a captcha token.

```bash
curl -s http://localhost:3001/api/build-nvidia/v1/models/nvidia/openai/gpt-oss-20b/queue
```

```json
{
  "function_id": "24d90582-d41c-4fc6-adc0-53c97f5a710f",
  "queues": [{
    "function_version_id": "3077edbc-34eb-4ed3-9e02-ef06b45cc731",
    "function_name": "ai-gpt-oss-20b",
    "function_status": "ACTIVE",
    "queue_depth": 0
  }]
}
```

Distinguishes hot (`queue_depth: 0, function_status: "ACTIVE"`) from queued (`queue_depth > 0`) from dead (404 here, or 404 from `/v1/chat/completions` for the slug).

### `GET /v1/blueprints`

NVIDIA blueprints (reference apps + agentic pipelines). Optional `?model=<vendor>/<slug>` filters to blueprints related to a specific model (the playground's "Related Blueprints" rail). Optional `?page=N` (default 1) and `?per_page=N` (default 20).

```bash
curl -s http://localhost:3001/api/build-nvidia/v1/blueprints?per_page=3
curl -s 'http://localhost:3001/api/build-nvidia/v1/blueprints?model=qwen/qwen3-coder-480b-a35b-instruct'
```

Returns `{ data: [...], total, page, per_page }`. Items are NVIDIA catalog resources with `displayName`, `name`, `description`, `orgName`, etc.

### `GET /v1/tools/blocklist`

List of tool names the playground hides from chat models — typically demo / internal-only tools that aren't broadly available.

```bash
curl -s http://localhost:3001/api/build-nvidia/v1/tools/blocklist
# {"tools":["get_current_weather"]}
```

Forwarding-tool clients can use this to filter their tool definitions to the playground's allowlist if they want to stay strictly on the supported path.

### `GET /v1/legal/:id`

Fetch a legal terms / model-license markdown block by id. Common ids: `model-terms-of-service`, `data-collection`.

```bash
curl -s http://localhost:3001/api/build-nvidia/v1/legal/model-terms-of-service
```

```json
{
  "id": "model-terms-of-service",
  "version": 2,
  "terms": "**Model Outputs.** AI models generate responses ..."
}
```

### `POST /v1/mint`

Mints a fresh, un-burned hCaptcha token + captures the upstream request shape. Use this when you want to call NVIDIA from a remote runtime (Lambda, edge worker, CI) with vanilla `fetch()`.

```bash
curl -s -X POST http://localhost:3001/api/build-nvidia/v1/mint \
  -H 'content-type: application/json' \
  -d '{"model":"nvidia/openai/gpt-oss-20b"}'
```

Returns:

```json
{
  "model": "nvidia/openai/gpt-oss-20b",
  "url": "https://api.ngc.nvidia.com/v2/predict/models/qc69jvmznzxy/gpt-oss-20b",
  "method": "POST",
  "headers": {
    "content-type": "application/json",
    "nv-captcha-token": "P1_eyJ0...",
    "nv-function-id": "24d90582-d41c-4fc6-adc0-53c97f5a710f"
  },
  "function_id": "24d90582-d41c-4fc6-adc0-53c97f5a710f",
  "captcha_token": "P1_eyJ0...",
  "expires_at": 1777826784,
  "ttl_seconds": 120,
  "sample_body": {
    "model": "openai/gpt-oss-20b",
    "messages": [{ "role": "user", "content": "hello" }],
    "stream": true,
    "max_tokens": 256,
    "reasoning_effort": "medium"
  },
  "curl_example": "curl -N -X POST '...' -H 'content-type: application/json' -H 'nv-captcha-token: P1_...' ..."
}
```

**Important constraints**:

- **Single-use**: each `captcha_token` mints exactly one chat call. Re-mint per request.
- **TTL ~120 seconds**.
- **Body field `model` must be the BARE `<vendor>/<slug>`** (e.g. `openai/gpt-oss-20b`), NOT the provider-prefixed form. The `headers` and `url` we return already encode the provider; only the body gets the bare form.
- **Three headers only** — no cookies, Origin, Referer, or UA needed.

The `curl_example` field is copy-pasteable and runs to completion against NVIDIA's live endpoint.

#### Cross-machine portability — verified end-to-end on AWS Lambda

The whole point of `/v1/mint` is that the bundle is portable. **Mint on a machine with the browser, ship the bundle to a runtime without one, call NVIDIA from there.** This was verified against a real AWS Lambda in `us-east-1`:

```text
                Mac (home IP 38.25.57.162)               AWS Lambda (us-east-1, IP 54.86.181.52)
   ┌──────────────────────────────────────┐       ┌──────────────────────────────────────────┐
   │ Patchright + build-nvidia API server │       │ nodejs20.x runtime, no browser            │
   │ POST /api/build-nvidia/v1/mint       │       │ event = bundle from /v1/mint             │
   │  → { url, headers, ttl_seconds:120 } │ ────▶ │ fetch(event.url, {                       │
   │                                      │       │   method: "POST",                        │
   │                                      │       │   headers: event.headers,                │
   │                                      │       │   body: <your OpenAI-shaped body>        │
   │                                      │       │ })                                       │
   └──────────────────────────────────────┘       └──────────────────────────────────────────┘
                                                                      │
                                                                      ▼
                                                            api.ngc.nvidia.com  →  HTTP 200
                                                            real OpenAI-shaped chat completion
```

Test results (4 iterations, mint locally → invoke Lambda → call NVIDIA from Lambda):

| Aspect | Result |
| --- | --- |
| Mint origin IP | `38.25.57.162` (residential ISP) |
| Lambda egress IP | `54.86.181.52` (AWS us-east-1) |
| Iterations | 4 / 4 returned **HTTP 200** with real chat completions |
| Lambda → NVIDIA latency | ~500–600 ms steady-state |
| Headers Lambda sent | exactly the 3 the bundle returned |

**What this proves:**

- The `nv-captcha-token` is **not IP-bound** — minted on home IP, accepted from AWS IP.
- Not **cookie-bound** — Lambda sent zero cookies.
- Not **TLS-fingerprint-bound** — Lambda's Node `fetch()` has a totally different TLS profile than the minting Patchright Chromium.
- Not bound to the original HTTP client at all. Everything NVIDIA validates is *inside* the token bytes.

**What this enables:**

- Run the browser + mint on one machine (your laptop, a single beefy box, a small EC2). Run the actual chat traffic on horizontally-scalable runtimes (Lambda, edge workers, fan-out queue consumers).
- Natural per-IP rate-limit defeat without any IP-rotation infrastructure on your side: Lambda recycles containers and rotates egress IPs as load grows.
- Token bundles are JSON. Ship them via SQS, Step Functions, S3, whatever — they're portable strings.

**Lambda smoke harness** in `domains/build-nvidia/lambda-smoke/`:

```bash
cd domains/build-nvidia/lambda-smoke
./deploy.sh                # creates IAM role + Lambda function (us-east-1)
node driver.mjs --n 5      # mints locally, invokes Lambda 5 times, prints results
./teardown.sh              # removes IAM role + Lambda when done
```

The handler in `lambda-smoke/lambda/index.mjs` is ~100 lines — copy-paste into any other Lambda, edge worker, or runtime. It accepts the bundle from `/v1/mint` as its event payload directly.

#### Operational notes for the mint-elsewhere pattern

- **Plan for the 120s TTL.** If your Lambda or queue consumer might queue longer than that, mint on demand — don't pre-mint and stash. The mint call is ~330 ms; just-in-time is cheap.
- **One token = one chat call.** Each `/v1/mint` produces a single-use bundle. For N parallel calls, mint N times.
- **Body field `model` must be bare** (`openai/gpt-oss-20b`, not `nvidia/openai/gpt-oss-20b`). The `sample_body` and `curl_example` fields use the right form already; if you hand-craft the body, match those.

### `POST /v1/raw/:provider/:vendor/:slug`

Modality-agnostic passthrough. Mints a captcha token, ships the caller's body verbatim to the predict URL, returns the upstream response unchanged. Use this when the model's request body doesn't fit OpenAI's chat shape.

```bash
curl -N -X POST 'http://localhost:3001/api/build-nvidia/v1/raw/nvidia/openai/gpt-oss-20b' \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

**Currently working for**: chat-modality models that render the standard hCaptcha widget on their playground page.

**Known limitation**: image / video / non-chat modalities — their playground pages don't render the same widget shape, so the SDK-binding mint times out. Use `/v1/mint` directly and call upstream from your own runtime if `/v1/raw` fails for a non-chat model.

## Server requirements

A persistent Patchright session under profile `build-nvidia`:

```bash
./scripts/connect-browser.sh --profile build-nvidia \
  --url 'https://build.nvidia.com/openai/gpt-oss-20b' --port 3001
```

The browser is just a token factory — every actual chat/raw request goes through Bun fetch.

## Quick verification

```bash
# Catalog
curl -s http://localhost:3001/api/build-nvidia/v1/models | jq '.data | length'

# Chat
curl -s -X POST http://localhost:3001/api/build-nvidia/v1/chat/completions \
  -H content-type:application/json \
  -d '{"model":"nvidia/openai/gpt-oss-20b","messages":[{"role":"user","content":"Just say PONG"}],"max_tokens":300}' \
  | jq '.choices[0].message.content'

# Mint + remote replay
RESP=$(curl -s -X POST http://localhost:3001/api/build-nvidia/v1/mint \
  -H content-type:application/json -d '{"model":"nvidia/openai/gpt-oss-20b"}')
eval "$(echo "$RESP" | jq -r .curl_example)" | head -3
```

Each of these completes successfully on the live `build.nvidia.com` infrastructure with no API key.
