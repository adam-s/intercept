# chatgpt — usage

How to run the plugin locally and call it. The route reference lives in [README.md](./README.md); this guide covers practical workflows, OpenAI SDK usage, web search, lifecycle/deprecation handling, and troubleshooting.

## Quickstart (4 commands)

```bash
# 1. Install + start API server (port 3001)
pnpm install
pnpm --filter @interceptor/api dev > /tmp/api-server.log 2>&1 &

# 2. Connect a browser to chatgpt.com
./scripts/connect-browser.sh --profile chatgpt --url https://chatgpt.com

# 3. (Optional) Harvest the Bearer token if you're using the /chat route
curl -X POST http://localhost:3001/api/chatgpt/session/harvest

# 4. Smoke test — OpenAI-compatible /v1 surface (no Bearer needed for anon flow)
curl -s http://localhost:3001/api/chatgpt/v1/models | jq '.data[].id'
```

The browser is required to mint OpenAI Sentinel tokens per request. The `/v1/chat/completions` surface uses the **anonymous** flow — no login needed. The legacy `/chat` route uses the harvested Bearer (logged-in flow).

## OpenAI SDK — drop-in

Point any OpenAI client at `http://localhost:3001/api/chatgpt/v1` with a fake API key.

### Python

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3001/api/chatgpt/v1", api_key="not-needed")

# Plain chat
r = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Say PONG"}],
)
print(r.choices[0].message.content)

# Web search — pass it as an OpenAI built-in tool
r = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "What did NVIDIA announce at GTC 2026?"}],
    tools=[{"type": "web_search"}],
)
print(r.choices[0].message.content)  # answer with sources block
print(r.citations)  # non-streaming only — list of {title, url}
```

`tools=[{"type": "web_search"}]`, `[{"type": "web_search_preview"}]`, and `[{"type": "function", "function": {"name": "web_search"}}]` are all recognized — they all flip ChatGPT's `system_hints: ["search"]` upstream. Other tool types are silently ignored (chatgpt's anonymous endpoint only supports the builtin web search).

The legacy `extra_body={"search": True}` form still works for backward compatibility.

### Node / TS

```ts
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://localhost:3001/api/chatgpt/v1',
  apiKey: 'not-needed',
});

const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Say PONG' }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
```

## curl cheat sheet

| Goal | One-liner (replace `…` with `http://localhost:3001/api/chatgpt`) |
|---|---|
| Health | `curl -s …/v1/health \| jq` |
| List active models | `curl -s …/v1/models \| jq '.data[].id'` |
| List deprecated | `curl -s '…/v1/models?lifecycle=deprecated' \| jq` |
| Chat (streaming) | `curl -s -N -X POST '…/v1/chat/completions' -H 'content-type:application/json' -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"stream":true}'` |
| Chat with web search | `curl -s -X POST '…/v1/chat/completions' -H 'content-type:application/json' -d '{"model":"gpt-4o","messages":[{"role":"user","content":"latest news"}],"tools":[{"type":"web_search"}],"stream":false}'` |
| Legacy `/chat` (Bearer) | `curl -s -X POST '…/chat' -H 'content-type:application/json' -d '{"message":"Hi","model":"gpt-4o"}'` |
| Session status | `curl -s …/session \| jq` |
| Session harvest | `curl -s -X POST …/session/harvest` |
| Set fingerprint persona | `curl -s -X PUT …/fingerprint/profile -H 'content-type:application/json' -d '{ "platform": "MacIntel", ... }'` |
| Attach fingerprint control | `curl -s -X POST …/fingerprint/attach -H 'content-type:application/json' -d '{"mode":"control"}'` |

## Lifecycle / deprecated models

`/v1/models` defaults to `?lifecycle=active` — deprecated GPT models are hidden. Use `?lifecycle=deprecated` or `?lifecycle=all` to see them. Each model carries `lifecycle: "active" | "deprecated" | "unknown"` and `deprecation_reason`.

Detection has two sources:

1. **Static known-bad list** in `src/lifecycle.ts` `KNOWN_DEPRECATED` — seeded from OpenAI's published deprecations (gpt-3.5-turbo-0613, gpt-4-32k, etc.). Update when OpenAI rotates models.
2. **Reactive failure cache** — every `/v1/chat/completions` call records its outcome. A single 410 / `model_not_found` response marks the model deprecated immediately; ≥ 2 unrelated 5xx within 24h trigger a soft mark. Auth/rate-limit/sentinel errors are ignored.

Calling a deprecated model returns:

```json
{
  "error": {
    "message": "Model gpt-3.5-turbo-0613 is deprecated.",
    "type": "invalid_request_error",
    "code": "model_deprecated",
    "deprecation_reason": "Deprecated by OpenAI. Use gpt-4o-mini..."
  }
}
```

with HTTP 410.

## Health & resilience

The plugin tracks consecutive Sentinel mint failures and surfaces operator guidance when stuck:

```bash
curl -s http://localhost:3001/api/chatgpt/v1/health | jq
# { "ok": true, "mint": { "total_calls": 42, "consecutive_failures": 0, ... } }
```

When `mint.stuck === true` (≥ 3 consecutive failures), the response includes a `hint` field with the exact reconnect command. After 8+ failures the hint upgrades to "switch network or clear cookies — likely IP/account block".

Upstream calls to `/backend-anon/f/conversation` are wrapped with a 90s `AbortSignal` timeout — stalled connections can't pin the response queue indefinitely.

## Operations

### Restarting

```bash
# Kill server + browser
lsof -ti:3001 | xargs kill -9 2>/dev/null
pkill -f connect-browser

# Restart
pnpm --filter @interceptor/api dev > /tmp/api-server.log 2>&1 &
sleep 6
./scripts/connect-browser.sh --profile chatgpt --url https://chatgpt.com
```

### Fingerprint privacy layer

The proxy can install a fingerprint persona over the 55 properties that Cloudflare Turnstile + OpenAI Sentinel read, so the challenge token encodes a chosen identity rather than the host machine's real one:

```bash
# Set a persona (any user-agent / OS / GPU combination)
curl -X PUT http://localhost:3001/api/chatgpt/fingerprint/profile \
  -H 'content-type: application/json' \
  -d '{ "userAgent": "...", "platform": "Linux x86_64", ... }'

# Attach control mode — replaces all 55 properties + 36 behavioral biometrics
curl -X POST http://localhost:3001/api/chatgpt/fingerprint/attach \
  -H 'content-type: application/json' -d '{"mode":"control"}'
```

See [TURNSTILE.md](./TURNSTILE.md) for the full taxonomy of what Sentinel reads and why each property matters.

## Troubleshooting

### `Sentinel-gated submit failed` with `severity: "persistent"`

The browser session is stuck. The error includes a `suggestion` field with the exact fix:

```bash
pkill -f connect-browser
./scripts/connect-browser.sh --profile chatgpt --url https://chatgpt.com
sleep 25
curl -X POST http://localhost:3001/api/chatgpt/session/harvest
```

If it persists with `severity: "likely_blocked"` after 8+ failures, OpenAI has rate-limited or temp-banned your IP/account. Switch network or clear chatgpt.com cookies in the browser, then reconnect.

### `Browser is not on chatgpt.com`

The browser navigated away. Re-navigate manually or via `./scripts/connect-browser.sh ... --url https://chatgpt.com`.

### `Model gpt-X is deprecated` (HTTP 410)

You're hitting a model OpenAI retired. Pass `?lifecycle=all` on `/v1/models` to see the suggested replacement, or update your client to use the modern equivalent (gpt-4o, gpt-4o-mini, o1, etc.).

### Web search returns no citations

Check the response — citations only appear when ChatGPT actually invokes search. For ambiguous queries it may answer from training data without searching. Phrase queries that demand fresh information ("latest", "today's", "after [date]") to force the search hint.

### "messages per hour" 403/429

ChatGPT's anonymous flow enforces per-device-id and per-IP rate limits. The plugin spaces /prepare calls to look human, but sustained traffic still trips the gates. Mitigations:
- Use the `/fingerprint/profile` route to rotate device-id between batches
- Add delays between requests (the plugin doesn't rate-limit you internally)
- Switch to the harvested-Bearer flow (`/chat`) if you have a logged-in session — different limits apply

## File layout

```
domains/chatgpt/
├── README.md           ← endpoint reference + Sentinel architecture
├── USAGE.md            ← this file
├── TURNSTILE.md        ← deep-dive on what Sentinel/Turnstile read
├── src/
│   ├── routes.ts            (legacy /chat + /session + /fingerprint/*)
│   ├── openai-adapter.ts    (/v1/chat/completions + /v1/models + /v1/health)
│   ├── lifecycle.ts         (reactive deprecation detection)
│   ├── mint-health.ts       (Sentinel mint resilience tracking)
│   ├── session.ts           (Bearer token harvesting)
│   ├── fingerprint.ts       (persona-installing init script)
│   └── …
├── experiments/        ← deep-logger, pre-mint-script bisection harness
└── challenges/         ← unrelated (HTTP/JSON challenges, leave alone)
```

## See also

- [README.md](./README.md) — full endpoint reference
- [TURNSTILE.md](./TURNSTILE.md) — what Sentinel reads, why
- `domains/build-nvidia/USAGE.md` — sister plugin (NVIDIA Build) with the same conventions, useful as a reference for resilience patterns
