/**
 * Yahoo Finance — the live price stream, subscribed and decoded.
 *
 * The socket is the distinctive transport on this site and the one most likely
 * to be written off. It is public — no cookie, no crumb — and every frame is a
 * JSON envelope whose `message` is base64-wrapped protobuf. A reader expecting
 * JSON sees a socket delivering noise and records it as empty.
 *
 * Two shapes are offered because a stream has two honest consumers. A snapshot
 * collects N frames and returns them, which suits a caller that wants current
 * prices. A subscription holds the connection open and forwards frames as
 * server-sent events, which suits a caller that wants the stream itself. Both
 * are bounded: an unbounded stream route is a socket nobody closes.
 *
 * @module domain-yahoofinance/routes
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import { DEBUG, rateLimitedFetch, withCompleteness } from '@interceptor/shared';
import { decodePricing } from './protobuf';

const STREAMER_URL = 'wss://streamer.finance.yahoo.com/?version=2';

/** Hard bounds. A route that can hold a socket open forever will. */
const LIMITS = { maxFrames: 50, maxSeconds: 60, defaultFrames: 5, defaultSeconds: 15 };

function symbolsOf(raw: string | undefined): string[] {
	return String(raw ?? 'AAPL')
		.split(',')
		.map((s) => s.trim().toUpperCase())
		.filter(Boolean)
		.slice(0, 25);
}

export const routes: DomainRoute[] = [
	{
		method: 'GET',
		path: '/stream/snapshot',
		examples: ['/stream/snapshot?symbols=AAPL,TSLA&frames=3'],
		upstream: ['wss://streamer.finance.yahoo.com/'],
		transport: 'WebSocket',
		description: 'Subscribe, collect a bounded number of decoded price frames, close.',
		browserRequired: false,
		handler: async (c) => {
			const url = new URL(c.req.url);
			const symbols = symbolsOf(url.searchParams.get('symbols') ?? undefined);
			const want = Math.min(
				Number(url.searchParams.get('frames') ?? LIMITS.defaultFrames),
				LIMITS.maxFrames,
			);
			const seconds = Math.min(
				Number(url.searchParams.get('seconds') ?? LIMITS.defaultSeconds),
				LIMITS.maxSeconds,
			);

			const { default: WebSocket } = await import('ws');
			const frames: Record<string, unknown>[] = [];

			const collected = await new Promise<Record<string, unknown>[]>((resolve) => {
				const ws = new WebSocket(STREAMER_URL);
				// The deadline resolves rather than rejects: a quiet market is a real
				// answer, and returning nothing with an explanation beats an error that
				// reads like the transport is broken.
				const deadline = setTimeout(() => {
					ws.close();
					resolve(frames);
				}, seconds * 1000);

				ws.on('open', () => {
					DEBUG('yahoofinance', `subscribing to ${symbols.join(',')}`);
					ws.send(JSON.stringify({ subscribe: symbols }));
				});
				ws.on('message', (raw: Buffer) => {
					let envelope: { message?: string };
					try {
						envelope = JSON.parse(raw.toString());
					} catch {
						return; // a non-JSON frame is the server's business, not ours
					}
					if (!envelope.message) return;
					frames.push(decodePricing(Buffer.from(envelope.message, 'base64')));
					if (frames.length >= want) {
						clearTimeout(deadline);
						ws.close();
						resolve(frames);
					}
				});
				ws.on('error', () => {
					clearTimeout(deadline);
					resolve(frames);
				});
				ws.on('close', () => {
					clearTimeout(deadline);
					resolve(frames);
				});
			});

			return c.json(
				withCompleteness({
					symbols,
					frames: collected,
					total: collected.length,
					_note: collected.length
						? 'Frames are base64-wrapped protobuf on a public socket; field names are those observed, unknown fields are reported by number.'
						: 'Subscribed successfully but no frame arrived inside the window — markets may be closed for these symbols. Not a failure of the transport.',
				}),
			);
		},
	},
	{
		method: 'GET',
		path: '/stream/subscribe',
		examples: ['/stream/subscribe?symbols=AAPL&seconds=8'],
		upstream: ['wss://streamer.finance.yahoo.com/'],
		transport: 'SSE',
		description: 'Hold the socket open and forward decoded frames as server-sent events.',
		browserRequired: false,
		handler: async (c) => {
			const url = new URL(c.req.url);
			const symbols = symbolsOf(url.searchParams.get('symbols') ?? undefined);
			const seconds = Math.min(
				Number(url.searchParams.get('seconds') ?? LIMITS.defaultSeconds),
				LIMITS.maxSeconds,
			);

			const { default: WebSocket } = await import('ws');
			const encoder = new TextEncoder();

			// A socket in, an event stream out — the subscription shape, so a caller
			// consumes it as it arrives instead of waiting for a batch.
			const body = new ReadableStream({
				start(controller) {
					const ws = new WebSocket(STREAMER_URL);
					let open = true;
					const send = (event: string, data: unknown) => {
						if (!open) return;
						controller.enqueue(
							encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
						);
					};
					const finish = (reason: string) => {
						if (!open) return;
						send('end', { reason });
						open = false;
						try {
							ws.close();
						} catch {
							/* already closing */
						}
						controller.close();
					};

					const deadline = setTimeout(() => finish('window elapsed'), seconds * 1000);
					ws.on('open', () => {
						// Announcing the subscription to the caller is not making it. The
						// server sends nothing until asked, so without this the stream
						// opens, stays silent, and closes on its deadline — a plausible
						// empty result that looks like a quiet market.
						ws.send(JSON.stringify({ subscribe: symbols }));
						send('open', { symbols });
					});
					ws.on('message', (raw: Buffer) => {
						try {
							const envelope = JSON.parse(raw.toString()) as { message?: string };
							if (envelope.message) {
								send('pricing', decodePricing(Buffer.from(envelope.message, 'base64')));
							}
						} catch {
							/* ignore a frame we cannot parse rather than ending the stream */
						}
					});
					ws.on('error', (err: Error) => {
						clearTimeout(deadline);
						finish(`socket error: ${String(err).slice(0, 80)}`);
					});
					ws.on('close', () => {
						clearTimeout(deadline);
						finish('upstream closed');
					});
				},
			});

			return new Response(body, {
				headers: {
					'content-type': 'text/event-stream',
					'cache-control': 'no-cache',
					connection: 'keep-alive',
				},
			});
		},
	},
	{
		method: 'GET',
		path: '/chart/:symbol',
		examples: ['/chart/AAPL?range=5d&interval=1d'],
		upstream: ['query1.finance.yahoo.com/v8/finance/chart/{symbol}'],
		transport: 'JSON API (XHR)',
		description: 'Price history. Public — no crumb, no session, no browser.',
		browserRequired: false,
		handler: async (c) => {
			const { symbol } = c.req.param() as Record<string, string>;
			const url = new URL(c.req.url);
			const range = url.searchParams.get('range') ?? '5d';
			const interval = url.searchParams.get('interval') ?? '1d';

			// Direct HTTP, and the reason is narrow: this endpoint answers without a
			// crumb, a cookie or a session, so there is nothing for the browser to
			// carry. That is a statement about today, not a guarantee. Anything
			// issued from the runtime has the runtime's TLS handshake rather than a
			// browser's, and a site that starts fingerprinting will refuse it while
			// the same request from inside a page still works. If this route begins
			// failing without an obvious cause, move it to the browser rung before
			// looking anywhere else.
			const res = await rateLimitedFetch(
				`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
			);
			if (!res.ok) return c.json({ error: `Chart returned ${res.status}`, symbol }, 502);
			const body = (await res.json()) as {
				chart?: { result?: Array<Record<string, unknown>>; error?: unknown };
			};
			if (body.chart?.error) return c.json({ error: body.chart.error, symbol }, 502);

			const result = body.chart?.result?.[0];
			const timestamps = (result?.timestamp as number[] | undefined) ?? [];
			const quote = (result?.indicators as { quote?: Array<Record<string, number[]>> } | undefined)
				?.quote?.[0];

			// Zipped into rows rather than passed through as parallel arrays: a caller
			// that has to index two arrays in step can silently misalign them.
			const candles = timestamps.map((t, i) => ({
				time: new Date(t * 1000).toISOString(),
				open: quote?.open?.[i] ?? null,
				high: quote?.high?.[i] ?? null,
				low: quote?.low?.[i] ?? null,
				close: quote?.close?.[i] ?? null,
				volume: quote?.volume?.[i] ?? null,
			}));

			return c.json(
				withCompleteness({
					symbol,
					range,
					interval,
					candles,
					total: candles.length,
					currency: (result?.meta as { currency?: string } | undefined)?.currency ?? null,
				}),
			);
		},
	},
	{
		method: 'GET',
		path: '/search',
		examples: ['/search?q=apple'],
		upstream: ['query1.finance.yahoo.com/v1/finance/search'],
		transport: 'JSON API (XHR)',
		description: 'Symbol lookup. Public, and the cheapest way to resolve a name to a ticker.',
		browserRequired: false,
		handler: async (c) => {
			const q = new URL(c.req.url).searchParams.get('q') ?? '';
			if (!q) return c.json({ error: 'q is required' }, 400);
			const res = await rateLimitedFetch(
				`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}`,
			);
			if (!res.ok) return c.json({ error: `Search returned ${res.status}` }, 502);
			const body = (await res.json()) as {
				quotes?: Array<Record<string, unknown>>;
				count?: number;
			};
			const quotes = body.quotes ?? [];
			return c.json(
				withCompleteness({
					query: q,
					quotes: quotes.map((r) => ({
						symbol: r.symbol,
						name: r.shortname ?? r.longname,
						exchange: r.exchDisp,
						type: r.quoteType,
					})),
					// The upstream's own count, kept so the completeness helper can compare
					// what arrived against what was claimed rather than assuming they match.
					total: body.count ?? quotes.length,
				}),
			);
		},
	},
	{
		method: 'GET',
		path: '/quote',
		examples: ['/quote?symbols=AAPL,TSLA'],
		upstream: [
			'query1.finance.yahoo.com/v1/test/getcrumb',
			'query1.finance.yahoo.com/v7/finance/quote',
		],
		transport: 'JSON API (XHR)',
		description: 'Current quotes. Crumb-gated: a token must be harvested from a page first.',
		handler: async (c, browser) => {
			const symbols = new URL(c.req.url).searchParams.get('symbols') ?? 'AAPL';

			// The gate this route exists to demonstrate. The crumb is *harvested* — a
			// value the server hands out to a session and the client copies back — as
			// distinct from one computed by running the site's code, or one the client
			// invents. Harvested is the only kind a plain HTTP client can obtain, and
			// only by holding a session first.
			// Seating the browser on the site is not the same as holding a session.
			// The crumb endpoint answers 406 to a page that has merely started
			// loading and 200 once the session cookies exist, so this waits for the
			// cookie rather than for a duration — a fixed sleep is a guess that gets
			// shorter as the machine gets faster.
			const first = symbols.split(',')[0]?.trim() || 'AAPL';
			if (!browser.getUrl().includes('finance.yahoo.com')) {
				await browser.navigate(`https://finance.yahoo.com/quote/${encodeURIComponent(first)}/`);
			}
			let established = false;
			for (let attempt = 0; attempt < 10 && !established; attempt++) {
				await new Promise((r) => setTimeout(r, 1000));
				const cookies = (await browser.evaluate(
					new Function('return document.cookie') as never,
				)) as string;
				established = /\bA1S?=/.test(String(cookies ?? ''));
			}
			if (!established) {
				DEBUG('yahoofinance', 'session cookie never appeared; harvesting anyway');
			}
			// Fetched from the site's own page, deliberately cross-origin.
			//
			// The obvious move is to let the helper reseat the document on the API's
			// host so the call becomes same-origin. That fails here with 406, and the
			// reason is worth keeping: reseating discards the `Origin` and `Referer`
			// the API actually checks. Same-origin is a convenience for CORS, not a
			// credential — an endpoint that wants to know which page is asking gets a
			// worse answer once you move the page.
			//
			// So the request goes from the page that has the session, across origins,
			// with credentials. That is also the rung that survives TLS
			// fingerprinting: a request issued inside the browser carries the
			// browser's own handshake, where anything issued from the runtime does
			// not and can be refused on that alone.
			const crumbRes = (await browser.evaluate(
				new Function(`return fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
					credentials: 'include',
				}).then((r) => r.text().then((t) => ({ status: r.status, body: t })))
				  .catch((e) => ({ status: 0, body: String(e).slice(0, 120) }))`) as never,
			)) as { status?: number; body?: string };
			const crumb = crumbRes?.status === 200 ? String(crumbRes.body ?? '').trim() : '';
			if (!crumb) {
				// Reported, not papered over: without the crumb there is no result to
				// approximate, and an empty quote list would read as "no such symbol".
				return c.json(
					{
						error: 'Could not harvest a crumb',
						crumbStatus: crumbRes?.status ?? null,
						sessionEstablished: established,
						symbols,
					},
					502,
				);
			}

			const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&crumb=${encodeURIComponent(crumb)}`;
			const res = (await browser.evaluate(
				new Function(`return fetch(${JSON.stringify(url)}, { credentials: 'include' })
					.then((r) => r.json().then((j) => ({ status: r.status, json: j })))
					.catch((e) => ({ status: 0, json: { error: String(e).slice(0, 120) } }))`) as never,
			)) as { status?: number; json?: unknown };
			if (res?.status !== 200) {
				return c.json({ error: `Quote returned ${res?.status}`, symbols }, 502);
			}
			const body = res.json as { quoteResponse?: { result?: Array<Record<string, unknown>> } };
			const quotes = body?.quoteResponse?.result ?? [];
			return c.json(
				withCompleteness({
					symbols: symbols.split(','),
					quotes: quotes.map((q) => ({
						symbol: q.symbol,
						price: q.regularMarketPrice,
						change: q.regularMarketChange,
						changePercent: q.regularMarketChangePercent,
						volume: q.regularMarketVolume,
						marketState: q.marketState,
					})),
					total: quotes.length,
					_gate: 'crumb harvested from a browser session',
				}),
			);
		},
	},
];
