import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

// Global exception handlers — prevent silent crashes during discovery agent runs.
// Without these, unhandled promise rejections (browser CDP errors, WebSocket race conditions)
// kill the process silently with no log output.
process.on('unhandledRejection', (reason) => {
	console.error('[FATAL] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
	console.error('[FATAL] Uncaught exception:', err);
	// Don't exit — keep the server running so agents can recover
});

import { analyzeDiscovery } from '@interceptor/browser/analysis/discovery';
import {
	autoStartHeadlessBrowser,
	clearTrafficBuffer,
	getActiveBrowser,
	getBrowserHealth,
	getTrafficEntries,
	getTrafficSummary,
	handleBrowserWebSocket,
} from '@interceptor/browser/handler';
import { createDomainProxy } from '@interceptor/browser/handler/api-proxy';
import { getDomain, listDomains } from '@interceptor/browser/handler/domain-loader';
import { connectBrowserRateLimiter } from '@interceptor/browser/remote';
import {
	recordRateLimitedRequest,
	releaseRateLimitSlot,
	validateConfig,
	waitForRateLimitSlot,
} from '@interceptor/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WSContext } from 'hono/ws';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import './register-domains'; // Side-effect: registers domain plugins

// Connect rate limiter to browserFetch so Chrome-based fetches respect rate limits
connectBrowserRateLimiter({
	wait: waitForRateLimitSlot,
	record: recordRateLimitedRequest,
	release: releaseRateLimitSlot,
});

import { getBridge } from './bridge';
import { browserMcp } from './browser-mcp';
import { formatStartupBanner } from './format';
import { addClient, getState, removeClient, resetState, setMultiplier, setRunning } from './state';

const config = validateConfig({
	name: 'interceptor-api',
	version: '0.0.1',
	environment: process.env.NODE_ENV ?? 'development',
});

// Create Hono app for REST routes
const app = new Hono();
app.use('/*', cors());

// Request timeout middleware — browser navigation can take 60s+, cap at 120s
app.use('/*', async (c, next) => {
	const timeout = setTimeout(() => {
		if (!c.res.headers.get('content-type')) {
			// Response not yet sent — send timeout error
			c.status(504);
			c.res = new Response(JSON.stringify({ error: 'Request timed out after 120s' }), {
				status: 504,
				headers: { 'content-type': 'application/json' },
			});
		}
	}, 120_000);
	try {
		await next();
	} finally {
		clearTimeout(timeout);
	}
});

app.get('/health', (c) => c.json({ status: 'ok' }));

// Browser endpoints — traffic capture for API discovery
app.get('/browser/health', (c) => c.json(getBrowserHealth()));

app.get('/browser/traffic', (c) => {
	const since = c.req.query('since');
	const sinceId = since ? Number.parseInt(since, 10) : undefined;
	return c.json(getTrafficEntries(sinceId));
});

app.get('/browser/traffic/summary', (c) => c.json(getTrafficSummary()));

app.delete('/browser/traffic', (c) => {
	const cleared = clearTrafficBuffer();
	return c.json({ cleared });
});

app.get('/browser/analysis', async (c) => {
	const browser = getActiveBrowser();
	if (!browser) {
		return c.json({ error: 'No active browser — connect via /browser/stream first' }, 503);
	}

	try {
		// Get page HTML and URL from the active browser
		const html = await browser.evaluate(() => document.documentElement.outerHTML);
		const pageUrl = browser.getUrl();

		// Get traffic entries from the capture buffer
		const { entries } = getTrafficEntries();

		const analysis = analyzeDiscovery(html, entries, pageUrl);
		return c.json(analysis);
	} catch (err) {
		return c.json(
			{ error: `Analysis failed: ${err instanceof Error ? err.message : String(err)}` },
			500,
		);
	}
});

// ─── Egress instrumentation ──────────────────────────────────────────
// The capture layer exists to be run, not assembled: these three endpoints are
// the whole instrumented pass, and `scripts/discover-probe.mjs --mode=manifest`
// drives them.

app.post('/browser/instrument', async (c) => {
	const browser = getActiveBrowser();
	if (!browser)
		return c.json({ error: 'No active browser — connect via /browser/stream first' }, 503);
	try {
		const installed = await browser.installInstrument();
		// Reporting installed when nothing was patched would send a run into a
		// capture that silently returns nothing.
		if (!installed) return c.json({ error: 'Instrument failed to install' }, 502);
		return c.json({ instrumented: true });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

app.get('/browser/instrument', (c) => {
	const browser = getActiveBrowser();
	if (!browser) return c.json({ error: 'No active browser' }, 503);
	// The clean-pass gate reads this. A session still carrying aids is not the
	// session an ordinary visitor gets, so an assertion against it measures the
	// wrong page.
	return c.json({ instrumented: browser.isInstrumented() });
});

app.delete('/browser/instrument', async (c) => {
	const browser = getActiveBrowser();
	if (!browser) return c.json({ error: 'No active browser' }, 503);
	try {
		return c.json(await browser.removeInstrument());
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

app.get('/browser/manifest', async (c) => {
	const browser = getActiveBrowser();
	if (!browser) return c.json({ error: 'No active browser' }, 503);
	try {
		// Wire-level entries fold in alongside the JS-level ones: a call seen by
		// both becomes one row that says so, and a call only the wire saw — a
		// service worker, a redirect — still gets a row.
		const { entries } = getTrafficEntries();
		const wire = entries.map((e) => ({ method: e.method, url: e.url, body: e.responseBody }));
		const result = await browser.captureManifest(wire);
		return c.json({
			...result,
			instrumented: browser.isInstrumented(),
			wireEntries: wire.length,
		});
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

// Browser MCP REST endpoints — used by the MCP server to control the browser
app.route('/browser/mcp', browserMcp);

// Domain API proxy routes — each domain's routes proxy through browserFetch()
// GET /api → list all domains and their routes
app.get('/api', (c) => {
	const domains = listDomains().map((name) => {
		const plugin = getDomain(name);
		return {
			name,
			routeCount: plugin?.routes?.length ?? 0,
			routes: plugin?.routes?.map((r) => `${r.method} /api/${name}${r.path}`) ?? [],
			// Concrete invocations, so a checker can exercise routes whose bare path
			// is not callable (path params, required query params).
			examples:
				plugin?.routes?.flatMap((r) =>
					(r.examples ?? []).map((e) => `${r.method} /api/${name}${e}`),
				) ?? [],
			// What each route consumes upstream, so the coverage check can correlate
			// captured traffic with built routes exactly rather than by name similarity.
			upstream: plugin?.routes?.flatMap((r) => r.upstream ?? []) ?? [],
			// Per-route detail, because the flattened lists above lose which route
			// declared what — and a gate that checks declarations needs exactly
			// that association to name the route that is missing one.
			routeDetail:
				plugin?.routes?.map((r) => ({
					method: r.method,
					path: `/api/${name}${r.path}`,
					examples: r.examples ?? [],
					upstream: r.upstream ?? [],
					transport: r.transport ?? null,
					hasTargetUrl: Boolean(r.targetUrl),
				})) ?? [],
		};
	});
	return c.json({ domains, browserConnected: getActiveBrowser() !== null });
});

// Mount each registered domain's proxy routes at /api/<domainName>/
for (const name of listDomains()) {
	const plugin = getDomain(name);
	if (plugin?.routes && plugin.routes.length > 0) {
		const proxy = createDomainProxy(name, plugin.routes, getActiveBrowser);
		app.route(`/api/${name}`, proxy);
	}
}

// Python bridge REST endpoint — dashboard pages call Python methods via HTTP
app.post('/api/python/:method', async (c) => {
	const method = c.req.param('method');
	try {
		const params = await c.req.json().catch(() => ({}));
		const bridge = await getBridge();
		const result = await bridge.call(method, params);
		return c.json({ result });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

// Create Node.js HTTP server
const server = createServer(async (req, res) => {
	try {
		let body: string | undefined;
		if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
			const chunks: Buffer[] = [];
			await new Promise<void>((resolve, reject) => {
				req.on('data', (chunk) => chunks.push(chunk));
				req.on('end', () => resolve());
				req.on('error', reject);
			});
			body = Buffer.concat(chunks).toString();
		}

		const response = await app.fetch(
			new Request(`http://${req.headers.host}${req.url}`, {
				method: req.method,
				headers: req.headers as Record<string, string>,
				body,
			}),
		);

		res.statusCode = response.status;
		response.headers.forEach((value, key) => {
			res.setHeader(key, value);
		});

		const buffer = await response.arrayBuffer();
		res.end(Buffer.from(buffer));
	} catch (err) {
		console.error('[api] Request error:', err instanceof Error ? err.message : err);
		res.statusCode = 500;
		res.end(JSON.stringify({ error: 'Internal Server Error' }));
	}
});

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });

// WebSocket client adapter for state management
class WSClientAdapter {
	closed = false;
	constructor(private ws: WebSocket) {}

	send(data: string | Buffer): void {
		if (this.closed) return;
		try {
			this.ws.send(data);
		} catch {
			this.closed = true;
		}
	}

	close(code?: number): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.ws.close(code);
		} catch {
			/* ignored */
		}
	}
}

// Handle WebSocket upgrade requests
server.on('upgrade', async (req: IncomingMessage, socket: Socket, head: Buffer) => {
	const url = req.url || '';
	const pathname = new URL(`http://localhost${url}`).pathname;

	try {
		wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
			if (pathname === '/ws') {
				// Dashboard state management WebSocket
				const adapter = new WSClientAdapter(ws);
				const wsContext = new WSContext({
					send: (data, _opts) =>
						adapter.send(
							typeof data === 'string'
								? data
								: Buffer.from(new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer)),
						),
					close: (code, reason) => ws.close(code, reason),
					readyState: ws.readyState as 0 | 1 | 2 | 3,
					raw: ws,
				});
				const client = addClient(wsContext);

				ws.on('message', async (data: Buffer) => {
					try {
						const msg = JSON.parse(data.toString());

						if (msg.type === 'compute') {
							// Handle compute messages (Python bridge)
							try {
								const bridge = await getBridge();
								const result = await bridge.call('compute', {
									numbers: msg.numbers,
								});
								adapter.send(
									JSON.stringify({
										type: 'compute:result',
										requestId: msg.requestId,
										data: result,
									}),
								);
							} catch (err) {
								adapter.send(
									JSON.stringify({
										type: 'compute:error',
										requestId: msg.requestId,
										error: err instanceof Error ? err.message : String(err),
									}),
								);
							}
						} else {
							// State management messages
							const state = getState();
							switch (msg.type) {
								case 'increment':
									setMultiplier(state.multiplier + 1);
									break;
								case 'decrement':
									setMultiplier(state.multiplier - 1);
									break;
								case 'set':
									if (typeof msg.value === 'number') {
										setMultiplier(msg.value);
									}
									break;
								case 'pause':
									setRunning(false);
									break;
								case 'play':
									setRunning(true);
									break;
								case 'reset':
									resetState();
									break;
							}
						}
					} catch (err) {
						console.error('WS message error:', err);
					}
				});

				ws.on('close', () => {
					removeClient(client);
				});
			} else if (pathname.startsWith('/browser/stream')) {
				// Browser streaming — launches Patchright, streams frames, captures traffic
				const requestUrl = new URL(`http://localhost${url}`);
				handleBrowserWebSocket(ws, requestUrl).catch((err) => {
					console.error('Browser handler error:', err);
				});
			} else {
				socket.destroy();
			}
		});
	} catch (err) {
		console.error('WebSocket upgrade error:', err);
		socket.destroy();
	}
});

console.log(formatStartupBanner(config));

const port = parseInt(process.env.PORT ?? '3001', 10);
server.listen(port, () => {
	console.log(`Server listening on http://localhost:${port}`);
	// Auto-start a headless browser so domain proxy routes (extractFromPage, browserFetch)
	// work immediately without requiring manual connection via the /browser dashboard.
	// The browser is shared: a subsequent WS connection reuses it (same profile) or
	// replaces it (different profile). Set BROWSER_AUTO_START=false to disable.
	if (process.env.BROWSER_AUTO_START !== 'false') {
		autoStartHeadlessBrowser('generic').catch((err) =>
			console.error('[browser] Auto-start failed:', err),
		);
	}
});
