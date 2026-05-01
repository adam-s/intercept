# ChatGPT Domain Plugin

Privacy-first proxy for `chatgpt.com`. Intercepts ChatGPT's internal conversation API and streams responses through the local API server. Includes a fingerprint privacy layer that replaces the 55 properties Cloudflare Turnstile / ChatGPT Sentinel reads with a custom persona, so the challenge token encodes your chosen identity rather than your real device.

## Routes

All routes are mounted at `/api/chatgpt/`.

### Chat

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat` | Proxy `chatgpt.com/backend-api/conversation`. Streams SSE response. Requires harvested session. |
| `GET` | `/models` | List available models from `backend-api/models`. |

**Request body for `/chat`:**
```json
{
  "message": "Hello!",
  "model": "gpt-4o",
  "conversationId": "(optional)",
  "parentMessageId": "(optional)"
}
```

### Session

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/session` | Status of harvested token (connected, age, email). |
| `POST` | `/session/harvest` | Extract Bearer token from the active browser page. |

### Fingerprint Privacy Layer

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/fingerprint/profile` | Active `FingerprintProfile` (null = passthrough). |
| `PUT` | `/fingerprint/profile` | Set persona profile (JSON body). |
| `POST` | `/fingerprint/attach` | Attach `ChatGPTScriptInterceptor` to browser page. Body: `{ "mode": "log" \| "control" }` |
| `GET` | `/fingerprint/log` | SSE stream of `FingerprintLogEntry` events showing what Turnstile/Sentinel is reading. |

`control` mode replaces all 55 Turnstile properties and the 36 `window.__oai_so_*` behavioral biometrics with persona data. `log` mode is read-only — records what the real page sends.

## Quick Start

```bash
# 1. Start the API server
pnpm --filter @interceptor/api dev

# 2. Connect browser (must be logged into chatgpt.com)
./scripts/connect-browser.sh --profile chatgpt --url https://chatgpt.com

# 3. Harvest Bearer token
curl -X POST http://localhost:3001/api/chatgpt/session/harvest

# 4. (Optional) Enable fingerprint control mode
curl -X POST http://localhost:3001/api/chatgpt/fingerprint/attach \
  -H 'Content-Type: application/json' \
  -d '{"mode":"control"}'

# 5. Send a message
curl -X POST http://localhost:3001/api/chatgpt/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is 2+2?"}' \
  --no-buffer
```

## Fingerprint Profile

A `FingerprintProfile` controls the persona Turnstile sees. All fields are optional — omit any to use passthrough for that property.

```json
{
  "webgl": {
    "vendor": "Apple Inc.",
    "renderer": "Apple M2"
  },
  "screen": {
    "width": 2560,
    "height": 1600,
    "colorDepth": 30
  },
  "hardware": {
    "hardwareConcurrency": 10,
    "deviceMemory": 8,
    "platform": "MacIntel"
  },
  "behavioral": {
    "keystrokeIntervalMs": 120,
    "mouseVelocityPxPerMs": 0.8
  }
}
```

Set it:
```bash
curl -X PUT http://localhost:3001/api/chatgpt/fingerprint/profile \
  -H 'Content-Type: application/json' \
  -d @my-profile.json
```

## Challenge Harness

`challenges/` contains a test harness that solves programming challenges by calling `POST /api/chatgpt/chat` and running automated tests against the generated code. See [challenges/README.md](challenges/README.md).

```bash
pnpm tsx domains/chatgpt/challenges/run.ts
```

## Source Files

| File | Purpose |
|------|---------|
| `src/types.ts` | All domain types: `FingerprintProfile`, `ChatRequest`, `ChatStreamEvent`, etc. |
| `src/fingerprint.ts` | `ChatGPTScriptInterceptor` — intercepts Turnstile scripts in log or control mode |
| `src/fingerprint-script.ts` | `buildChatGPTFingerprintScript()` — generates the 55-property anti-detection IIFE |
| `src/session.ts` | `ChatGPTSessionManager` — harvests and stores the Bearer token |
| `src/routes.ts` | All 8 Hono route handlers |
| `src/index.ts` | `DomainPlugin` export + named exports |
