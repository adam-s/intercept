# ChatGPT Challenge Harness

Solves coding challenges by calling the ChatGPT domain proxy (`POST /api/chatgpt/chat`). Fingerprint control runs in the background to prevent bot detection from interfering.

## Challenges

| # | Name | Solution file | Test command |
|---|------|--------------|-------------|
| 1 | SQLite Window Functions | `queries.js` | `node test.js` |
| 2 | Hono + Bun WebSocket Counter | `server.ts` | `bun server.ts & node test.js` |
| 3 | Python CSV Reporter | `report.py` | `python3 test.py` |

## Setup

```bash
# 1. Start the API server
pnpm --filter @interceptor/api dev

# 2. Connect the chatgpt browser profile (in another terminal)
./scripts/connect-browser.sh --profile chatgpt --url https://chatgpt.com

# 3. Harvest session token
curl -X POST http://localhost:3001/api/chatgpt/session/harvest

# 4. Attach fingerprint control (privacy mode)
curl -X POST http://localhost:3001/api/chatgpt/fingerprint/attach \
  -H 'Content-Type: application/json' \
  -d '{"mode":"control"}'

# 5. Run the harness
pnpm tsx domains/chatgpt/challenges/run.ts

# Run a single challenge
pnpm tsx domains/chatgpt/challenges/run.ts 1-sqlite-windows
```

## How It Works

For each challenge:
1. Read input files (`seed.sql`, CSV data, etc.)
2. Build a precise prompt describing the expected output format
3. `POST /api/chatgpt/chat` → streams SSE response from ChatGPT
4. Extract the code block from the response
5. Write the solution file to a temp directory
6. Copy input files + install dependencies
7. Run the test command and report pass/fail

## Files

```
challenges/
├── challenges.ts          # Challenge definitions + prompts
├── run.ts                 # Main harness script
├── 1-sqlite-windows/
│   ├── seed.sql           # 100-row orders table
│   └── test.js            # Test suite (node test.js)
├── 2-hono-websocket/
│   └── test.js            # Test suite (bun server.ts & node test.js)
└── 3-csv-reporter/
    ├── data/sales.csv     # 50-row sales data
    └── test.py            # Test suite (python3 test.py)
```
