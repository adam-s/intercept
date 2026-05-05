# build-nvidia — usage

How to run the plugin locally and call every modality. Reference docs for each endpoint live in [API.md](./API.md); this guide is the practical how-to.

## Quickstart (3 commands)

```bash
# 1. Install + start API server (port 3001)
pnpm install
pnpm --filter @interceptor/api dev > /tmp/api-server.log 2>&1 &

# 2. Connect a browser session (one-time per machine; persists across restarts)
./scripts/connect-browser.sh --profile build-nvidia \
  --url 'https://build.nvidia.com/openai/gpt-oss-20b' --port 3001

# 3. Smoke test
curl -s http://localhost:3001/api/build-nvidia/v1/models?per_page=3 | jq '.data[].id'
```

The browser is a "captcha factory" — it mints fresh `nv-captcha-token` per request via NVIDIA's hCaptcha SDK trap. Keep it alive while the server runs. Every actual chat/embed/audio call goes through Bun fetch, not the browser.

## OpenAI SDK — drop-in

The `/v1` surface is OpenAI-compatible. Point any client at `http://localhost:3001/api/build-nvidia/v1` with a fake API key.

### Python

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3001/api/build-nvidia/v1", api_key="not-needed")

# Chat
r = client.chat.completions.create(
    model="nvidia/openai/gpt-oss-20b",
    messages=[{"role": "user", "content": "Say PONG"}],
)
print(r.choices[0].message.content)

# Tool calling
r = client.chat.completions.create(
    model="nvidia/qwen/qwen3.5-397b-a17b",
    messages=[{"role": "user", "content": "What's the weather in Tokyo?"}],
    tools=[{"type": "function", "function": {
        "name": "get_weather", "description": "Get current weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
    }}],
    tool_choice="auto",
)
print(r.choices[0].message.tool_calls)

# Vision (data URL or http URL — both work; assets uploaded automatically)
r = client.chat.completions.create(
    model="nvidia/meta/llama-3.2-11b-vision-instruct",
    messages=[{"role": "user", "content": [
        {"type": "text", "text": "What color is this?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBOR..."}},
    ]}],
)

# Embeddings
r = client.embeddings.create(
    model="nvidia/nvidia/llama-nemotron-embed-vl-1b-v2",
    input=["hello world", "how are you"],
)
print(len(r.data[0].embedding))  # 2048

# TTS — note: openai SDK calls /v1/audio/speech, response is WAV (not mp3)
speech = client.audio.speech.create(
    model="nvidia/nvidia/magpie-tts-multilingual",
    voice="Magpie-Multilingual.EN-US.Sofia",
    input="Hello world",
)
speech.write_to_file("hello.wav")
```

### Node / TS

```ts
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://localhost:3001/api/build-nvidia/v1',
  apiKey: 'not-needed',
});

const r = await client.chat.completions.create({
  model: 'nvidia/openai/gpt-oss-20b',
  messages: [{ role: 'user', content: 'Say PONG' }],
  stream: true,
});
for await (const chunk of r) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
```

## Modality cheat sheet (curl)

| Goal | One-liner |
|---|---|
| List active models | `curl -s '…/v1/models?per_page=10' \| jq .` |
| List deprecated | `curl -s '…/v1/models?all=1&lifecycle=deprecated' \| jq .` |
| Chat (streaming) | `curl -s -N -X POST '…/v1/chat/completions' -H 'content-type:application/json' -d '{"model":"nvidia/openai/gpt-oss-20b","messages":[{"role":"user","content":"hi"}],"stream":true}'` |
| Embed | `curl -s -X POST '…/v1/embeddings' -H 'content-type:application/json' -d '{"model":"nvidia/nvidia/llama-nemotron-embed-vl-1b-v2","input":["hello"]}'` |
| Rerank | `curl -s -X POST '…/v1/rerank' -H 'content-type:application/json' -d '{"model":"nvidia/nvidia/llama-nemotron-rerank-vl-1b-v2","query":"X","passages":["A","B"]}'` |
| TTS | `curl -s -X POST '…/v1/audio/speech' -H 'content-type:application/json' -d '{"model":"nvidia/nvidia/magpie-tts-multilingual","input":"hello"}' -o speech.wav` |
| ASR (preferred — JSON+base64) | `B64=$(base64 -i clip.wav \| tr -d '\n'); echo "{\"audio_base64\":\"$B64\",\"model\":\"nvidia/openai/whisper-large-v3\",\"language\":\"en\"}" \| curl -s -X POST '…/v1/audio/transcriptions' -H 'content-type:application/json' --data-binary @-` |
| Image-gen (flux) | `curl -s -X POST '…/v1/raw/nvidia/black-forest-labs/flux_1-schnell' -H 'content-type:application/json' -d '{"prompt":"a red cube","width":1024,"height":1024,"mode":"base","steps":4,"seed":0}'` |
| Upload asset for re-use | `curl -s -X POST '…/v1/files' -H 'content-type:image/png' --data-binary @cat.png` |
| Mint portable bundle (for Lambda) | `curl -s -X POST '…/v1/mint' -H 'content-type:application/json' -d '{"model":"nvidia/openai/gpt-oss-20b"}'` |

Replace `…` with `http://localhost:3001/api/build-nvidia` in all of the above.

## Picking models

Use `/v1/models?capability=<X>` to filter:

```bash
# Tool-calling capable
curl -s '…/v1/models?capability=tool_calling' | jq '.data[].id'

# Vision
curl -s '…/v1/models?capability=vision' | jq '.data[].id'

# Reasoning (gpt-oss-*, deepseek-r1-*, …)
curl -s '…/v1/models?capability=reasoning' | jq '.data[].id'

# Long-context
curl -s '…/v1/models?capability=long_context' | jq '.data[].id'

# Combine — repeat ?capability= for AND
curl -s '…/v1/models?capability=tool_calling&capability=reasoning' | jq '.data[].id'
```

## Lambda / remote runtime

Mint a portable token bundle locally, ship to Lambda, call NVIDIA from there. Verified working in `lambda-smoke/`:

```bash
cd lambda-smoke
./deploy.sh             # creates IAM role + Lambda function (us-east-1)
node driver.mjs --n 5   # mints locally, invokes Lambda 5 times
./teardown.sh           # cleanup when done
```

The bundle from `/v1/mint` includes the captcha token, function-id, and a working `curl_example` you can paste anywhere. TTL is ~120 seconds; tokens are single-use. See [lambda-smoke/](./lambda-smoke/) for the reference handler.

## Operations

### Restarting

```bash
# Kill server + browser
lsof -ti:3001 | xargs kill -9 2>/dev/null
pkill -f connect-browser

# Restart
pnpm --filter @interceptor/api dev > /tmp/api-server.log 2>&1 &
sleep 6
./scripts/connect-browser.sh --profile build-nvidia \
  --url 'https://build.nvidia.com/openai/gpt-oss-20b' --port 3001
```

The `build-nvidia` browser profile persists captcha state under `data/browser-profiles/build-nvidia/`. Reusing it avoids re-warming on every server restart.

### Logs

```bash
tail -f /tmp/api-server.log | grep build-nvidia
```

### Avoiding deprecated models

Default `/v1/models` already hides retired models. The detection is automatic — no action needed. To see what's been flagged:

```bash
curl -s 'http://localhost:3001/api/build-nvidia/v1/models?all=1&lifecycle=deprecated' \
  | jq '.data[] | {id, deprecation_reason}'
```

Currently confirmed dead (NVIDIA quietly removed their predict endpoints):
- `qwen/qwen3.5-122b-a10b` → use `qwen3.5-397b-a17b`
- `moonshotai/kimi-k2.6`, `kimi-k2-thinking`
- `google/gemma-4-31b-it`, `gemma-3-27b-it`
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`
- `mistralai/mistral-medium-3-instruct`
- `black-forest-labs/flux_1-dev`

If you hit a model that returns `INTERNAL_ERROR: Empty body`, the reactive failure cache will mark it deprecated automatically after 2 occurrences within 24h.

## Troubleshooting

### `Mint failed: SDK trap or widget not ready before timeout`

The browser session is stale or NVIDIA's anti-bot just woke up. Reconnect:

```bash
pkill -f connect-browser
sleep 2
./scripts/connect-browser.sh --profile build-nvidia \
  --url 'https://build.nvidia.com/openai/gpt-oss-20b' --port 3001
sleep 25  # let the page fully load + SDK trap install
```

If it persists for 5+ minutes, NVIDIA has temporarily IP-blocked you. Switch networks or wait ~10 minutes. **Disconnecting/reconnecting your VPN reliably gets a fresh IP** if you have one.

### `INTERNAL_ERROR: Empty body` on a chat call

The model has been silently retired by NVIDIA. Check the lifecycle:

```bash
curl -s 'http://localhost:3001/api/build-nvidia/v1/models/nvidia/<vendor>/<slug>/queue' | jq .
```

A 404 with `"NVCF function ... not found"` confirms it. The plugin will mark it deprecated after the next /v1/models refresh.

### `Captcha required` (HTTP 400) from upstream

The captcha token was rejected — usually transient. The chat route auto-retries once with a fresh mint. If you hit this directly through `/v1/raw`, mint a new bundle.

### ASR returns empty text or 500

If you're using **multipart**, switch to **JSON + base64** — Bun's runtime corrupts non-ASCII bytes in multipart bodies (a real bug, not config). Encode locally first:

```bash
B64=$(base64 -i clip.wav | tr -d '\n')
echo "{\"audio_base64\":\"$B64\",\"model\":\"nvidia/openai/whisper-large-v3\"}" \
  | curl -s -X POST '…/v1/audio/transcriptions' \
    -H 'content-type:application/json' --data-binary @-
```

### `bge-m3` returns 500 from gateway

Upstream-side issue (verified 2026-05-05). Use `nvidia/llama-nemotron-embed-vl-1b-v2` instead — same body shape, also OpenAI-compatible response.

## File layout

```
domains/build-nvidia/
├── API.md          ← endpoint reference (every route, every body shape)
├── USAGE.md        ← this file
├── package.json
├── src/            ← route handlers + helpers
│   ├── routes.ts          (the registered DomainRoute[] table)
│   ├── lifecycle.ts       (deprecation detection)
│   ├── model-metadata.ts  (catalog enrichment)
│   ├── browser-chat.ts    (UI-driven chat fallback)
│   ├── captcha-frame.ts   (hCaptcha SDK trap + binding mint)
│   └── …
├── lambda-smoke/   ← AWS Lambda harness for /v1/mint portability
│   ├── deploy.sh
│   ├── driver.mjs
│   └── lambda/index.mjs
├── scripts/        ← e7-* experiments + observation tooling
└── challenges/     ← unrelated (Hono/SQLite challenges, leave alone)
```

## See also

- [API.md](./API.md) — every endpoint, every parameter, every response shape
- [lambda-smoke/](./lambda-smoke/) — reference handler for remote runtimes
- `/Users/adamsohn/Projects/toolkit/experiments/playground-probe/SURFACE-MAP.md` — full discovery log + fixtures (~470 fixture files)
