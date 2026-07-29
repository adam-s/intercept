/**
 * Test Server — Composable fake websites for end-to-end pipeline testing.
 *
 * Four sites simulate different real-world transport patterns:
 * - /sites/boardshop/  — E-commerce: embedded JSON, pagination, CSRF, DOM elements
 * - /sites/liveboard/  — Real-time: WebSocket protobuf and JSON, crumb auth
 * - /sites/streamshop/ — Media: GraphQL, HLS streams, IRC chat
 * - /sites/databoard/  — API-heavy: gRPC-Web, encoded APIs, Bearer auth
 * - /sites/newsboard/  — Modern front end: SSE, long-poll, data in HTML
 *                        attributes, HTML fragments, worker and service-worker
 *                        scope, cross-frame RPC, beacons
 * - /sites/benchmark/  — Calibration: one call per egress primitive, on load
 */

import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';

import { createBenchmarkSite } from './sites/benchmark';
import { createBoardshopSite } from './sites/boardshop';
import { createDataboardSite } from './sites/databoard';
import { createHcaptchaSite } from './sites/hcaptcha';
import { createLiveboardSite } from './sites/liveboard';
import { createNewsboardSite } from './sites/newsboard';
import { createStreamshopSite } from './sites/streamshop';
import { createTurnstileSite } from './sites/turnstile';
import { handleWSUpgrade, type WSRoute } from './transports/websocket';

export interface TestServerOptions {
	port?: number;
}

export interface TestServerInstance {
	port: number;
	url: string;
	close: () => Promise<void>;
}

const SITES = [
	'benchmark',
	'boardshop',
	'liveboard',
	'newsboard',
	'streamshop',
	'databoard',
	'turnstile',
	'hcaptcha',
] as const;

const WS_ROUTES: WSRoute[] = [
	{ path: '/sites/liveboard/stream', mode: 'protobuf' },
	{ path: '/sites/liveboard/ws/json', mode: 'json' },
	{ path: '/sites/streamshop/chat', mode: 'irc', channel: 'boardshop-live' },
	{ path: '/sites/boardshop/ws/notifications', mode: 'json' },
	{ path: '/sites/boardshop/ws/subscriptions', mode: 'graphql-ws' },
	{ path: '/sites/boardshop/ws/binary', mode: 'binary' },
	{ path: '/sites/benchmark/ws', mode: 'json' },
	{ path: '/sites/newsboard/chat', mode: 'json' },
	{ path: '/sites/newsboard/pricing', mode: 'protobuf' },
];

export async function createTestServer(
	options: TestServerOptions = {},
): Promise<TestServerInstance> {
	const app = new Hono();

	// Health check
	app.get('/health', (c) => c.json({ status: 'ok', sites: [...SITES] }));

	// Root — inventory of all sites
	app.get('/', (c) =>
		c.json({
			sites: SITES.map((name) => ({
				name,
				url: `/sites/${name}/`,
			})),
		}),
	);

	// Mount sites
	app.route('/sites/benchmark', createBenchmarkSite());
	app.route('/sites/boardshop', createBoardshopSite());
	app.route('/sites/liveboard', createLiveboardSite());
	app.route('/sites/newsboard', createNewsboardSite());
	app.route('/sites/streamshop', createStreamshopSite());
	app.route('/sites/databoard', createDataboardSite());
	app.route('/sites/turnstile', createTurnstileSite());
	app.route('/sites/hcaptcha', createHcaptchaSite());

	// Create HTTP server
	const httpServer = createServer(async (req, res) => {
		// Normalize: strip a trailing slash (except root) so Hono routing matches
		// consistently. Split the query off first — testing `endsWith('/')` on the
		// whole URL never fires once there is a query string, so `/catalog/?q=x`
		// stayed unnormalized and 404'd while `/catalog?q=x` worked. A caller
		// reads that as "this endpoint has no search" rather than as a routing
		// quirk, which is the kind of wrong conclusion a fixture must not teach.
		const raw = req.url ?? '/';
		const q = raw.indexOf('?');
		let path = q === -1 ? raw : raw.slice(0, q);
		const search = q === -1 ? '' : raw.slice(q);
		if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
		const url = path + search;

		const response = await app.fetch(
			new Request(`http://localhost${url}`, {
				method: req.method,
				headers: Object.entries(req.headers).reduce(
					(acc, [k, v]) => {
						if (v) acc[k] = Array.isArray(v) ? v.join(', ') : v;
						return acc;
					},
					{} as Record<string, string>,
				),
				body:
					req.method !== 'GET' && req.method !== 'HEAD'
						? await new Promise<string>((resolve) => {
								let data = '';
								req.on('data', (chunk: Buffer) => {
									data += chunk.toString();
								});
								req.on('end', () => resolve(data));
							})
						: undefined,
			}),
		);

		// Build response headers — special handling for Set-Cookie which requires
		// multiple header values (Object.fromEntries would merge them into one)
		const headerObj: Record<string, string | string[]> = {};
		for (const [k, v] of response.headers.entries()) {
			if (k === 'set-cookie') continue; // handled below
			headerObj[k] = v;
		}
		const setCookies = response.headers.getSetCookie();
		if (setCookies.length > 0) {
			headerObj['set-cookie'] = setCookies;
		}

		res.writeHead(response.status, headerObj);
		const body = await response.arrayBuffer();
		res.end(Buffer.from(body));
	});

	// WebSocket server
	const wss = new WebSocketServer({ noServer: true });

	httpServer.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
		const url = request.url ?? '';
		const route = WS_ROUTES.find((r) => url.startsWith(r.path));

		if (!route) {
			socket.destroy();
			return;
		}

		wss.handleUpgrade(request, socket, head, (ws) => {
			handleWSUpgrade(ws, route);
		});
	});

	// Start listening
	const port = options.port ?? 0;
	await new Promise<void>((resolve) => {
		httpServer.listen(port, () => resolve());
	});

	const assignedPort = (httpServer.address() as { port: number }).port;

	return {
		port: assignedPort,
		url: `http://localhost:${assignedPort}`,
		close: () =>
			new Promise<void>((resolve) => {
				wss.close();
				httpServer.close(() => resolve());
			}),
	};
}
