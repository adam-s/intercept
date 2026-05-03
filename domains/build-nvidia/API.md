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

POST /v1/chat/completions                    OpenAI chat (streaming + non-streaming)
POST /v1/mint                                Token bundle for remote runtimes
POST /v1/raw/:provider/:vendor/:slug         Modality-agnostic passthrough
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
