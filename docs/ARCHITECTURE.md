# Architecture

The specific facts a fresh agent needs: what lives where, which command starts
what, and which ports things bind. [AGENTS.md](../AGENTS.md) holds principles
and deliberately holds none of this — when a constant here changes, change it
here, not there.

## What this is

Discover a website's internal API by intercepting browser traffic, then create a
domain plugin with typed proxy routes. The browser is the API client: reach for
`browserFetch` first, run elimination to find the minimum auth, store the result
in `GenericSessionManager`, and verify with `rateLimitedFetch` last.

`domains/boardshop/` is the executable reference. It carries working code for
every transport type — XHR pagination, session harvest, embedded JSON, GraphQL,
WebSocket, and click-intercept. [ROUTES.md](../domains/boardshop/ROUTES.md)
indexes them.

## Packages

| Path | Package | What it is |
|---|---|---|
| `apps/api/` | `@interceptor/api` | Hono API server, WebSocket, browser streaming |
| `apps/web/` | `@interceptor/web` | Next.js frontend |
| `packages/browser/` | `@interceptor/browser` | Browser automation + transport classifier |
| `packages/shared/` | `@interceptor/shared` | Shared types, validation, transport-tier guard, debug logging |
| `packages/test-server/` | `@interceptor/test-server` | Fake websites for validating discovery, self-contained |
| `packages/db/` | `@interceptor/db` | Drizzle ORM + TimescaleDB (optional) |
| `services/python/` | — | Python worker for the IPC bridge |
| `domains/<name>/` | `@interceptor/domain-<name>` | Domain plugins — ephemeral, one per target site |

Import paths are `@interceptor/<package>`. TypeScript strict mode throughout;
Vitest for tests, Biome for lint and format.

## Ports and endpoints

| Port | Service |
|---|---|
| 3000 | Web (Next.js) |
| 3001 | API (Hono) |
| 3002 | E2E test server (Playwright) |
| 4444 | Test server — fake sites |

| Endpoint | Purpose |
|---|---|
| `ws://localhost:3001/browser/stream?profile=<domain>&url=<target>` | Browser WebSocket. Only WS-connected browsers capture traffic. |
| `GET /browser/traffic` | Captured traffic for the connected browser |
| `GET /api/<domain>/<path>` | Domain proxy route |

Test server sites: boardshop (embedded JSON), liveboard (WebSocket + protobuf),
streamshop (GraphQL + HLS), databoard (gRPC-Web + encoded).

Frontend API URLs are relative (`/api/...`), never absolute to a host and port.

## Commands

```bash
pnpm dev                              # All services (API 3001, Web 3000)
pnpm --filter @interceptor/api dev    # API only
pnpm --filter @interceptor/web dev    # Web only
pnpm --filter @interceptor/test-server start   # Test server on 4444

./scripts/ci-local.sh                 # Full CI — run before committing
./scripts/ci-local.sh --quick         # Same, minus the Docker builds
pnpm test:repo                        # Repo-level pins only (drift, script contracts)

node scripts/route-spec.mjs --help    # The asserting tier over domain routes
node scripts/snapshot.mjs --help      # Report-only UI capture
```

Every `scripts/*.mjs` states its purpose, usage, and hard bounds in a header
docblock. That docblock is the contract — read it rather than inferring bounds
from the code.

## Debug logs

```ts
import { DEBUG } from '@interceptor/shared';
```

Output lands in `/tmp/interceptor-debug/`. Read it grep-first and bounded
(`tail -n`); these files grow without limit and an unbounded read costs more
than it returns.

## The server does not reload domain files

Editing a file under `domains/` has no effect on a running API server. Write
every file first — `routes.ts`, `config.ts`, `interceptor.ts`, `index.ts`,
`package.json` — then update `apps/api/src/register-domains.ts` and
`apps/api/package.json`, run `pnpm install`, then stop the server and start it
once. When a route needs a fix: edit, stop the server, start it. Do not
investigate why old code is running.

## Worktrees

An agent whose `pwd` is under `/tmp/interceptor-worktrees/` writes only inside
that worktree — never the original repo. Once there:

- Run `pnpm install` once. If it fails, fix the error rather than retrying with
  different flags.
- Free the port before starting the API server: `lsof -ti:PORT | xargs kill`.
  Start once.
- Edit `register-domains.ts` in the worktree to import the domain plugin.
- Test routes through `localhost:PORT/api/<domain>/<route>`.
- Connect a browser for traffic capture. Discovery by direct HTTP alone misses
  transport types.

## Process cleanup

Stop everything started before finishing or switching context:

```bash
pkill -f "connect-browser"              # Browser sessions
pkill -f "tsx.*src/index"               # tsx watchers
lsof -ti:3001 | xargs kill 2>/dev/null  # API server
lsof -ti:3000 | xargs kill 2>/dev/null  # Web server
```

## Transport tiers

`packages/shared/src/transport-tier.ts` makes the transport ladder a typed
failure rather than a convention. Register a host with
`registerTransportTier(host, 'session-gated')` once elimination shows plain HTTP
does not reach it; `rateLimitedFetch` then throws `TransportTierError` at the
call site instead of returning a bot-wall page a route would parse as data.
