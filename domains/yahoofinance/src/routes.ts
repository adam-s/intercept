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
 * Three more transports came out of reading the wire capture past what the
 * synthetic sweep ranked first: a predefined screener (JSON API, public,
 * hundreds of symbols per list — the site's own 100+-item listing), the
 * homepage's news/video stream (GraphQL, cookie-gated), and per-video HLS
 * manifests (public, discovered by following a video id the GraphQL route
 * surfaces). None of the three showed up on a page that was merely loaded;
 * the screener call fires on homepage load but ranks below ad/analytics
 * traffic until the capture is read past the sweep's top rows, the GraphQL
 * call needs a hero-stream widget to mount, and the video id only exists once
 * something in the stream is a video.
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
	{
		method: 'GET',
		path: '/screener/:id',
		examples: ['/screener/MOST_ACTIVES?count=25', '/screener/DAY_GAINERS?count=25&start=25'],
		upstream: ['query1.finance.yahoo.com/v1/finance/screener/predefined/saved'],
		transport: 'JSON API (XHR)',
		description:
			'A predefined screener list (most actives, day gainers/losers, ...). Public, ' +
			'no crumb — the same rung as /chart and /search. Discovered by scanning the ' +
			'homepage traffic rather than a click: the widget that calls it fires on load, ' +
			'not behind an interaction, but it never showed up until the full wire capture ' +
			"was read past the sweep's own top-ranked rows. This is the site's own \"100+ " +
			'items" listing — MOST_ACTIVES alone runs to hundreds of symbols.',
		browserRequired: false,
		handler: async (c) => {
			const { id } = c.req.param() as Record<string, string>;
			const url = new URL(c.req.url);
			const count = Math.min(Number(url.searchParams.get('count') ?? 25), 200);
			const start = Math.max(Number(url.searchParams.get('start') ?? 0), 0);

			const res = await rateLimitedFetch(
				`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&start=${start}&formatted=false&scrIds=${encodeURIComponent(id)}&sortField=&sortType=&useRecordsResponse=true&fields=symbol,shortName,regularMarketPrice,regularMarketChangePercent,regularMarketVolume&lang=en-US&region=US`,
			);
			if (!res.ok) return c.json({ error: `Screener returned ${res.status}`, id }, 502);
			const body = (await res.json()) as {
				finance?: { result?: Array<Record<string, unknown>>; error?: unknown };
			};
			if (body.finance?.error) return c.json({ error: body.finance.error, id }, 502);

			const result = body.finance?.result?.[0];
			// `useRecordsResponse=true` (set below, matching the page's own request) is
			// not cosmetic — it renames the item array from the classic `quotes` to
			// `records`. Checked both, in that order, so a route built against a
			// captured shape that later drops the flag does not silently start
			// returning zero items with a nonzero total.
			const quotes =
				((result?.records ?? result?.quotes) as Array<Record<string, unknown>> | undefined) ?? [];
			// The upstream's own criteriaMeta.size is the count it was asked for, not
			// the count that exists — the indicated total lives on the result itself
			// when present, and falls back to what actually came back rather than to a
			// request parameter that says nothing about the underlying list.
			const indicatedTotal =
				(result?.total as number | undefined) ??
				(result?.criteriaMeta as { total?: number } | undefined)?.total ??
				quotes.length;

			return c.json(
				withCompleteness({
					screenerId: id,
					title: result?.title ?? id,
					start,
					count,
					// The `records` shape names fields `ticker`/`companyName`, not the `symbol`/
					// `shortName` of every other route on this domain — verified by printing
					// one raw record, because the requested `fields=symbol,shortName,...` list
					// is silently ignored under `useRecordsResponse=true` rather than filtering
					// to it. Both are checked so this keeps working if the flag is ever dropped.
					quotes: quotes.map((q) => ({
						symbol: q.ticker ?? q.symbol,
						name: q.companyName ?? q.shortName,
						price: q.regularMarketPrice,
						changePercent: q.regularMarketChangePercent,
						volume: q.regularMarketVolume,
					})),
					total: indicatedTotal,
				}),
			);
		},
	},
	{
		method: 'GET',
		path: '/news/home',
		examples: ['/news/home?start=0&count=10'],
		upstream: ['nexus-gateway-prod.media.yahoo.com/'],
		transport: 'GraphQL',
		description:
			"The homepage's hero news/video stream. GraphQL, and it needed the browser: a " +
			'cross-origin replay from the page carrying Yahoo identity cookies (A1/A1S/A3) ' +
			'answers 200, and elimination never tried a plain HTTP client because the same ' +
			'gap that makes /quote crumb-gated applies here — no crumb this time, but the ' +
			'session cookies are still a credential a bare fetch does not have.',
		handler: async (c, browser) => {
			const url = new URL(c.req.url);
			const start = Math.max(Number(url.searchParams.get('start') ?? 0), 0);
			const count = Math.min(Number(url.searchParams.get('count') ?? 10), 25);

			if (!browser.getUrl().includes('finance.yahoo.com')) {
				await browser.navigate('https://finance.yahoo.com/');
			}

			// The persisted query text and fragment set are exactly what the page's own
			// bundle sent — captured, not reconstructed. `x-yahoo-cg-client-version`
			// carries a build timestamp the site rotates on deploy; if this route starts
			// failing where /quote still works, that header is the first thing to refresh
			// from a fresh capture.
			// The full fragment set, unedited — GraphQL validates that every declared
			// variable is used somewhere in the document, so trimming the Image/
			// Resolutions fragments this route does not care about (it drops
			// thumbnails from the response) breaks the query with "$imageTransforms
			// is never used" rather than silently ignoring the dead code.
			const query =
				'query FinanceHomeHeroStream($listInput: LightyearListInput!, $clientContext: ClientContext!, $start: Int!, $count: Int!, $imageTransforms: [MysterioTransformsInput]! = [], $includeImageTransforms: Boolean! = true) {\n  lightyearList(\n    list_input: $listInput\n    cc: $clientContext\n    start: $start\n    count: $count\n  ) {\n    ...LightyearListHydratedStream\n  }\n}\nfragment Resolutions on MysterioImage {\n  url\n  height\n  width\n  transformLabel\n}\nfragment Image on Image {\n  type: imgType\n  originalUrl: url\n  originalHeight: height\n  originalWidth: width\n  resolutions: mysterioImages(transformInputs: $imageTransforms) @include(if: $includeImageTransforms) {\n    ...Resolutions\n  }\n}\nfragment ContentAttributes on ContentAttributes {\n  description\n  summary\n  pubDate: publishTime\n  displayTime\n  isHosted\n  canonicalUrl\n  clickthroughUrl\n  provider {\n    displayName\n    url\n    providerContentUrl\n    providerId\n  }\n  thumbnail {\n    ...Image\n  }\n}\nfragment FinanceStockTickers on Finance {\n  stockTickers {\n    symbol\n  }\n}\nfragment StoryData on Story {\n  id: uuid\n  __typename\n  title\n  previewUrl(cc: $clientContext)\n  isPremiumNews\n  isLiveBlog\n  embeddedLiveBlog {\n    status\n  }\n  contentAttributes {\n    ...ContentAttributes\n  }\n  finance {\n    ...FinanceStockTickers\n  }\n}\nfragment VideoData on Video {\n  id: uuid\n  __typename\n  title\n  duration\n  previewUrl(cc: $clientContext)\n  liveEventInfo {\n    scheduledStartTime\n    scheduledStopTime\n    status\n  }\n  contentAttributes {\n    ...ContentAttributes\n  }\n  finance {\n    ...FinanceStockTickers\n  }\n}\nfragment OutlinkData on Outlink {\n  __typename\n  uuid\n  description\n  displayTime\n  headline\n  url\n  provider {\n    displayName\n    url\n    providerContentUrl\n    providerId\n  }\n  contentAttributes {\n    thumbnail {\n      ...Image\n    }\n  }\n}\nfragment HydratedStoryOrVideoAsset on HydratedAsset {\n  __typename\n  asset {\n    __typename\n    ... on Story {\n      ...StoryData\n    }\n    ... on Video {\n      ...VideoData\n    }\n    ... on Outlink {\n      ...OutlinkData\n    }\n  }\n}\nfragment PaginationInfo on PaginationInfo {\n  totalCount\n  start\n  nextPage: hasNextPage\n  count\n}\nfragment LightyearListHydratedStream on LightyearList {\n  main: contentItems {\n    stream: assets {\n      ...HydratedStoryOrVideoAsset\n    }\n    pageInfo {\n      ...PaginationInfo\n    }\n  }\n}';
			const variables = {
				clientContext: { device: 'desktop', lang: 'en-US', region: 'US', site: 'finance' },
				count,
				imageTransforms: [],
				includeImageTransforms: false,
				listInput: {
					disableDedupe: false,
					enableBlockedContent: false,
					enableMab: true,
					enableQueryTimeLicenseCheck: true,
					mabPlacementAlias: 'finance.us.en-us',
					uuid: '8b3fc5c7-6c5d-422d-a821-83f569089c0e',
				},
				start,
			};
			const requestBody = { operationName: 'FinanceHomeHeroStream', query, variables };

			const gqlRes = (await browser.evaluate(
				new Function(`return fetch('https://nexus-gateway-prod.media.yahoo.com/', {
					method: 'POST',
					credentials: 'include',
					headers: {
						'content-type': 'application/json',
						'accept': 'application/json',
						'x-yahoo-cg-client-name': 'finance',
						'x-yahoo-cg-client-version': '0.1.13926.1785359856',
					},
					body: JSON.stringify(${JSON.stringify(requestBody)}),
				}).then((r) => r.json().then((j) => ({ status: r.status, json: j })))
				  .catch((e) => ({ status: 0, json: { error: String(e).slice(0, 120) } }))`) as never,
			)) as { status?: number; json?: unknown };

			if (gqlRes?.status !== 200) {
				return c.json({ error: `News stream returned ${gqlRes?.status}`, start, count }, 502);
			}
			const data = gqlRes.json as {
				data?: {
					lightyearList?: {
						main?: {
							stream?: Array<{ asset?: Record<string, unknown> }>;
							pageInfo?: { totalCount?: number; nextPage?: boolean };
						};
					};
				};
			};
			const main = data.data?.lightyearList?.main;
			const items = main?.stream ?? [];

			return c.json(
				withCompleteness({
					start,
					count,
					items: items.map((entry) => {
						const asset = entry.asset ?? {};
						return {
							type: asset.__typename,
							id: asset.id,
							title: asset.title,
							url:
								(asset.contentAttributes as { canonicalUrl?: string } | undefined)?.canonicalUrl ??
								asset.url,
							summary: (asset.contentAttributes as { summary?: string } | undefined)?.summary,
							tickers: (
								(asset.finance as { stockTickers?: Array<{ symbol: string }> } | undefined)
									?.stockTickers ?? []
							).map((t) => t.symbol),
						};
					}),
					total: main?.pageInfo?.totalCount ?? items.length,
					hasNextPage: main?.pageInfo?.nextPage ?? false,
					_gate: 'cross-origin fetch from a page holding Yahoo identity cookies',
				}),
			);
		},
	},
	{
		method: 'GET',
		path: '/video/:id',
		examples: ['/video/8af61f2d-2734-459a-9f9f-67a1844c179a'],
		upstream: ['video-api.yql.yahoo.com/v1/video/sapi/streams/{id}'],
		transport: 'HLS/Media',
		description:
			'Video metadata and stream addresses for a Yahoo Finance video (ids surface in ' +
			'/news/home items where type is "Video"). Public — no crumb, no session. The ' +
			"resource this returns is a real handle, not a description of one: each stream's " +
			'host+path is a working master.m3u8 URL, verified end to end by fetching it and ' +
			'reading actual #EXT-X-STREAM-INF renditions back — HLS/Media reads absent from ' +
			'the homepage sweep because nothing there plays automatically, and only shows up ' +
			'once the video id this route needs is followed.',
		browserRequired: false,
		handler: async (c) => {
			const { id } = c.req.param() as Record<string, string>;
			const res = await rateLimitedFetch(
				`https://video-api.yql.yahoo.com/v1/video/sapi/streams/${encodeURIComponent(id)}?format=m3u8,mp4,webm&region=US&site=finance&lang=en-US`,
			);
			if (!res.ok) return c.json({ error: `Video API returned ${res.status}`, id }, 502);
			const body = (await res.json()) as {
				query?: { results?: { mediaObj?: Array<Record<string, unknown>> } };
			};
			const media = body.query?.results?.mediaObj?.[0];
			if (!media) return c.json({ error: 'No media object for id', id }, 404);

			const meta = media.meta as Record<string, unknown> | undefined;
			const streams = (media.streams as Array<Record<string, unknown>> | undefined) ?? [];

			return c.json(
				withCompleteness({
					id,
					title: meta?.title,
					description: meta?.description,
					durationSeconds: meta?.duration,
					thumbnail: meta?.thumbnail,
					// bcov_auth is a signed, short-lived JWT the upstream hands out with the
					// URL itself — harvested, not invented, and it expires (~1hr from the
					// token's own `iat`). A caller that waits before fetching gets a 403, not
					// a bug in this route.
					streams: streams.map((s) => ({
						url: `${s.host}${s.path}`,
						format: s.format,
						mimeType: s.mime_type,
						bitrate: s.bitrate,
						width: s.width,
						height: s.height,
					})),
					total: streams.length,
				}),
			);
		},
	},
];
