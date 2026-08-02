/**
 * BoardShop API Routes (Reference Example)
 *
 * Every transport type in the discovery protocol has a working route here.
 * All routes work against the test server (port 4444):
 *   pnpm --filter @interceptor/test-server start
 *
 * ═══════════════════════════════════════════════════════════════════════
 * REAL-WORLD ANALOGUE GUIDE
 *
 * When discovering a new site, find the route below that matches what
 * the site does. The "like" column names the real-world pattern:
 *
 *   Route 32 (collection listings) → encoded pricing with session harvest
 *     Seed page → harvest session cookie → extract API config from embedded
 *     data → call paginated XHR with harvested cookie + API key → decode
 *
 *   Route 33 (click-intercept)     → click-intercept POST pagination
 *     Page embeds first page of data; subsequent pages load via POST when
 *     user clicks "Show More". Patchright clicks the button, intercepts
 *     the POST responses, aggregates all pages.
 *
 *   Route 31 (resale listings)     → like WAF-gated POST pagination
 *     Multiple cookies (WAF + session) required. Harvest from seed page,
 *     then POST with JSON body for each page.
 *
 *   Route 30 (drops inventory)     → like httpOnly-cookie-gated APIs
 *     httpOnly cookie can't be read via JS. Harvest from Set-Cookie
 *     header on seed page fetch, pass to subsequent API calls.
 *
 *   Route 7 (POST pagination)      → like CSRF-protected form submission
 *     POST body with CSRF token + session cookie + page number.
 *
 *   Route 15 (__NEXT_DATA__)        → Next.js embedded data
 *     Next.js embeds full data in __NEXT_DATA__. Pagination may be
 *     URL-based (?page=2) returning new HTML with new __NEXT_DATA__.
 *
 *   Route 8 (GraphQL)              → public GraphQL endpoint
 *     Public GraphQL endpoint, no auth needed. Pagination via query vars.
 *
 * For cross-origin APIs behind Akamai/WAF:
 *   - Direct curl returns 403 (Akamai blocks non-browser requests)
 *   - page.evaluate("fetch(url, {credentials:'include'})") works because
 *     the browser has WAF sensor cookies. Use this during GATHER to test.
 *   - In route handlers, use browserFetch which operates at CDP level.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * EMBEDDED JSON:
 *  1. GET /catalog              — Parse <script id="catalog-data"> from HTML
 *  2. GET /product/:sku         — Different script ID on detail page
 *
 * JSON API:
 *  3. GET /availability         — Escalation: rateLimitedFetch → browserFetch on 429
 *  4. GET /reviews              — Cursor-based pagination (string cursors)
 *  5. GET /products             — Direct JSON API with X-API-Key header
 *  6. GET /inventory/:sku       — Custom-header-gated endpoint (404 without headers)
 *  7. POST /catalog/page/:page  — POST pagination with CSRF + session tokens
 *
 * GRAPHQL:
 *  8. GET /graphql-example      — Inline query with Client-ID auth (streamshop)
 *
 * HLS MEDIA:
 *  9. GET /hls-example          — Token → master playlist → variants (streamshop)
 *
 * ENCODED API:
 * 10. GET /encoded-example      — Base64-encoded JSON with Bearer auth (databoard)
 * 11. GET /msgpack-example      — MessagePack binary response (databoard)
 *
 * CRUMB/TOKEN AUTH:
 * 12. GET /crumb-example        — REST API with crumb token from page source (liveboard)
 *
 * WEBSOCKET:
 * 13. GET /ws-json-example      — WebSocket JSON frames, capture N updates (liveboard)
 * 14. GET /ws-protobuf-example  — WebSocket protobuf frames, base64-wrapped (liveboard)
 *
 * FRAMEWORK-SPECIFIC EMBEDDED JSON:
 * 15. GET /nextjs-example       — __NEXT_DATA__ with Redux state (boardshop /nextjs)
 * 16. GET /deferred-example     — data-deferred-state-0 deep nesting (boardshop /deferred)
 *
 * QUERY-PARAM METHOD DISPATCH:
 * 17. GET /method-example       — POST ?method=X query param API (boardshop /methods)
 *
 * BASE64 CURSOR PAGINATION:
 * 18. GET /cursor-example       — Base64-encoded cursor pagination (boardshop /catalog/cursor)
 *
 * RATE-LIMIT BAIL-OUT:
 * 19. GET /chart/:sku           — 429 after first call, falls back to embedded JSON
 *
 * HYDRATION-STRIPPED EMBEDDED JSON:
 * 20. GET /hydrated-example     — Script tags removed by JS hydration, use raw HTTP
 *
 * SVELTEKIT FETCHED DATA:
 * 21. GET /sveltekit-example    — JSON envelope double-parse (boardshop /sveltekit)
 *
 * JSONP CALLBACK:
 * 22. GET /jsonp-example        — Strip callback wrapper to parse JSON
 *
 * CAPTIONS / TIMED TEXT:
 * 23. GET /captions-example/:sku — Structured timed text from media endpoint
 *
 * PUBSUB NOTIFICATION WEBSOCKET:
 * 24. GET /notifications-example — Secondary WS for push notifications
 *
 * GRAPHQL SUBSCRIPTION:
 * 25. GET /gql-subscription-example — graphql-ws protocol over WebSocket
 *
 * CUSTOM BINARY WEBSOCKET:
 * 26. GET /binary-ws-example     — Raw binary frames with header + payload
 *
 * RSS / XML FEED:
 * 27. GET /rss-example           — Parse RSS XML with cheerio
 *
 * SSR HTML TABLE PARSING:
 * 28. GET /ssr-example           — Parse HTML tables with cheerio (pure SSR)
 *
 * FORMDATA POST:
 * 29. GET /formdata-search-example — Multipart/form-data search request
 *
 * SESSION HARVESTER — httpOnly cookie + correlation header:
 * 30. GET /drops/inventory        — Session-gated paginated inventory (drops pattern)
 *
 * SESSION HARVESTER — WAF cookie + POST pagination:
 * 31. GET /resale/listings        — Multi-cookie session-gated POST pagination (resale pattern)
 *
 * ENCODED PRICING + SESSION HARVEST:
 * 32. GET /collection/:id/listings — Seed page → harvest session → extract API config
 *     from embedded data → call paginated XHR with cookie + API key → decode prices
 *
 * CLICK-INTERCEPT PAGINATION ("Show More" POST pagination):
 * 33. GET /resale/all — Patchright clicks "Load More", intercepts POST responses,
 *     collects all pages. Use when pagination requires browser interaction.
 *
 * CAPTCHA-GATED — Turnstile-shape (invisible widget mint → replay):
 * 34. GET /captcha-turnstile — Mint `0.<b64url>` token in browser via window.captchaWidget,
 *     POST to verify endpoint. Generic Cloudflare-Turnstile-style integration.
 *
 * CAPTCHA-GATED — hCaptcha-shape (challenge → proof → JWT-shape token):
 * 35. GET /captcha-hcaptcha — Capture `P1_<b64url>.<b64url>.<b64url>` token via
 *     postMessage + /api/check interception, replay in x-captcha-token header.
 *
 * @module domain-boardshop/routes
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import { evaluateInMainWorld } from '@interceptor/browser/shared/main-world';
import { DEBUG, rateLimitedFetch, withCompleteness } from '@interceptor/shared';

const BASE_URL = process.env.BOARDSHOP_URL ?? 'http://localhost:4444/sites/boardshop';
const LIVEBOARD_URL = 'http://localhost:4444/sites/liveboard';
const STREAMSHOP_URL = 'http://localhost:4444/sites/streamshop';
const DATABOARD_URL = 'http://localhost:4444/sites/databoard';
const TURNSTILE_URL = 'http://localhost:4444/sites/turnstile';
const HCAPTCHA_URL = 'http://localhost:4444/sites/hcaptcha';
const NEWSBOARD_URL = 'http://localhost:4444/sites/newsboard';

/** Helper: extract <script id="X" type="application/json"> from HTML */
function extractScript(html: string, id: string): unknown | null {
	const re = new RegExp(
		`<script\\s+id="${id}"\\s+type="application/json"[^>]*>([\\s\\S]*?)</script>`,
	);
	const match = html.match(re);
	if (!match) return null;
	try {
		return JSON.parse(match[1]);
	} catch {
		return null;
	}
}

/** Helper: get Bearer token from databoard */
async function getDataboardToken(): Promise<string> {
	const res = await rateLimitedFetch(`${DATABOARD_URL}/api/auth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ clientId: 'boardshop-reference' }),
	});
	const auth = (await res.json()) as { access_token: string };
	return auth.access_token;
}

export const routes: DomainRoute[] = [
	// ═══════════════════════════════════════════════════════════════════
	// EMBEDDED JSON
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 1: Embedded JSON — catalog page ───────────────────────
	{
		method: 'GET',
		path: '/catalog',
		examples: ['/catalog', '/catalog?q=deck'],
		upstream: ['localhost:4444/sites/boardshop/'],
		transport: 'Embedded JSON',
		description: 'Product catalog via embedded JSON extraction.',
		browserRequired: false,
		handler: async (c) => {
			const q = new URL(c.req.url).searchParams.get('q') ?? '';
			const url = `${BASE_URL}/${q ? `?q=${encodeURIComponent(q)}` : ''}`;

			DEBUG('boardshop', `catalog: fetching ${url}`);
			const res = await rateLimitedFetch(url);
			if (!res.ok) return c.json({ error: `Page returned ${res.status}` }, 502);
			const html = await res.text();

			const data = extractScript(html, 'catalog-data') as {
				catalog: {
					items: unknown[];
					totalCount: number;
					pageSize: number;
					currentPage: number;
					filterSessionId: string;
					itemsRemaining: number;
				};
				searchQuery: string;
			} | null;
			if (!data) return c.json({ error: 'Embedded JSON not found' }, 404);

			return c.json(
				withCompleteness({
					items: data.catalog.items,
					total: data.catalog.totalCount,
					page: data.catalog.currentPage,
					pageSize: data.catalog.pageSize,
					remaining: data.catalog.itemsRemaining,
					query: data.searchQuery,
				}),
			);
		},
	},

	// ─── Route 2: Embedded JSON — detail page (different script ID) ──
	{
		method: 'GET',
		path: '/product/:sku',
		examples: ['/product/DECK-001'],
		upstream: ['localhost:4444/sites/boardshop/product/{sku}'],
		transport: 'Embedded JSON',
		description: 'Product detail via embedded JSON extraction.',
		browserRequired: false,
		handler: async (c) => {
			const sku = (c.req.param() as Record<string, string>).sku;
			const res = await rateLimitedFetch(`${BASE_URL}/product/${sku}`);
			if (!res.ok) return c.json({ error: `Product page returned ${res.status}` }, 502);
			const html = await res.text();

			const data = extractScript(html, 'product-data');
			if (!data) return c.json({ error: 'Product data not found' }, 404);
			return c.json(data);
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// JSON API
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 3: Escalation — rateLimitedFetch → browserFetch ───────
	// The endpoint returns 429 for non-browser User-Agents.
	{
		method: 'GET',
		path: '/availability',
		examples: ['/availability', '/availability?category=decks'],
		upstream: ['localhost:4444/sites/boardshop/api/availability'],
		transport: 'JSON API (XHR)',
		description: 'Escalation: direct HTTP → browserFetch on 429.',
		handler: async (c, browser) => {
			const category = new URL(c.req.url).searchParams.get('category') ?? '';
			const url = `${BASE_URL}/api/availability${category ? `?category=${encodeURIComponent(category)}` : ''}`;

			const directRes = await rateLimitedFetch(url, {
				headers: { Accept: 'application/json' },
			});
			if (directRes.ok) return c.json(await directRes.json());

			if (directRes.status === 429 || directRes.status === 403) {
				DEBUG('boardshop', `availability: blocked (${directRes.status}), escalating`);
				const browserRes = await browser.browserFetch<Record<string, unknown>>(url);
				return c.json(browserRes.data ?? { error: 'Browser fetch failed' });
			}
			return c.json({ error: `API returned ${directRes.status}` }, 502);
		},
	},

	// ─── Route 4: Cursor-based pagination ────────────────────────────
	// Boardshop /reviews uses string cursors (after=REV-0005).
	{
		method: 'GET',
		path: '/reviews',
		examples: ['/reviews?limit=5'],
		upstream: ['localhost:4444/sites/boardshop/reviews'],
		transport: 'JSON API (XHR)',
		description: 'Cursor-paginated reviews via direct JSON API.',
		browserRequired: false,
		handler: async (c) => {
			const url = new URL(c.req.url);
			const after = url.searchParams.get('after') ?? '';
			const limit = url.searchParams.get('limit') ?? '10';

			const apiUrl = `${BASE_URL}/reviews?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
			DEBUG('boardshop', `reviews: fetching ${apiUrl}`);

			const res = await rateLimitedFetch(apiUrl);
			if (!res.ok) return c.json({ error: `Reviews API returned ${res.status}` }, 502);
			return c.json(await res.json());
		},
	},

	// ─── Route 5: Direct JSON API with API key from <meta> tag ───────
	// API key discovered in page source: <meta name="api-key" content="pk_test_...">
	{
		method: 'GET',
		path: '/products',
		examples: ['/products?page=1'],
		upstream: ['localhost:4444/sites/boardshop/api/products'],
		transport: 'JSON API (XHR)',
		description: 'Products via JSON API with X-API-Key header.',
		browserRequired: false,
		handler: async (c) => {
			const url = new URL(c.req.url);
			const page = url.searchParams.get('page') ?? '1';
			const category = url.searchParams.get('category') ?? '';

			// In discovery, you'd extract the API key from the page's <meta> tag.
			const API_KEY = 'pk_test_boardshop_abc123';

			const apiUrl = `${BASE_URL}/api/products?page=${page}&pageSize=20${category ? `&category=${category}` : ''}`;
			DEBUG('boardshop', `products: fetching ${apiUrl}`);

			const res = await rateLimitedFetch(apiUrl, {
				headers: { 'X-API-Key': API_KEY },
			});
			if (!res.ok) return c.json({ error: `Products API returned ${res.status}` }, 502);
			return c.json(withCompleteness(await res.json()));
		},
	},

	// ─── Route 6: Custom-header-gated endpoint ───────────────────────
	// Returns 404 (not 401) without X-App-Platform + X-App-Region headers.
	// You discover these headers by reading captured traffic or JS bundles.
	{
		method: 'GET',
		path: '/inventory/:sku',
		examples: ['/inventory/DECK-001', '/inventory/NO-SUCH-SKU'],
		upstream: ['localhost:4444/sites/boardshop/api/inventory/{sku}'],
		/**
		 * REFERENCE: declaring a non-2xx that is an ANSWER rather than a fault.
		 *
		 * An unknown SKU has no inventory, and saying so with a 404 is a complete
		 * answer to the question asked. Without this declaration the assertion tier
		 * treats every non-2xx as a failure, so a route whose resource is
		 * legitimately sometimes absent goes red for behaving correctly — and a
		 * permanently red route teaches a reader to skip the whole domain.
		 *
		 * The obligation travels with the declaration, and this is the part to copy:
		 * the transport must still be proved somewhere that cannot answer absent.
		 * Here the first example does it — a SKU that exists returns 200 with real
		 * inventory — so the 404 example covers the missing case without becoming
		 * the only thing ever checked. A declaration with no such sibling is a check
		 * that cannot fail, which is worse than no check at all.
		 *
		 * Do not reach for this to quiet a route that is simply broken. If the
		 * upstream is erroring, the red is correct.
		 */
		contractualStatuses: [404],
		transport: 'JSON API (XHR)',
		description: 'Warehouse inventory with custom headers discovered from traffic.',
		browserRequired: false,
		handler: async (c) => {
			const sku = (c.req.param() as Record<string, string>).sku;
			const res = await rateLimitedFetch(`${BASE_URL}/api/inventory/${sku}`, {
				headers: {
					'X-App-Platform': 'web',
					'X-App-Region': 'us-east',
				},
			});
			// REFERENCE: pass an upstream "not found" through as not-found.
			//
			// This mapped every upstream failure to 502, including a 404, which
			// claimed a gateway fault for an answer the upstream gave correctly. The
			// distinction to copy: 404 means the upstream understood the question and
			// there is no such thing, which the caller needs to be able to tell from
			// the upstream being broken. Collapsing both into 502 makes an ordinary
			// missing record indistinguishable from an outage.
			if (res.status === 404) {
				return c.json({ sku, found: false, error: 'No inventory for that SKU' }, 404);
			}
			if (!res.ok) return c.json({ error: `Inventory API returned ${res.status}` }, 502);
			return c.json(await res.json());
		},
	},

	// ─── Route 7: POST pagination with CSRF + session tokens ─────────
	// Step 1: GET page → extract CSRF from hidden input, filterSessionId
	//         from embedded JSON, session cookie from Set-Cookie header.
	// Step 2: POST with all three tokens for page 2+.
	{
		method: 'GET',
		path: '/catalog/page/:page',
		examples: ['/catalog/page/1', '/catalog/page/2'],
		upstream: ['localhost:4444/sites/boardshop/'],
		transport: 'Form-encoded POST',
		description: 'POST pagination with CSRF + session token extraction.',
		browserRequired: false,
		handler: async (c) => {
			const pageNum = Number((c.req.param() as Record<string, string>).page);

			// Step 1: GET page to extract tokens
			DEBUG('boardshop', `pagination: fetching page 1 for tokens`);
			const pageRes = await rateLimitedFetch(BASE_URL);
			if (!pageRes.ok) return c.json({ error: `Page returned ${pageRes.status}` }, 502);
			const html = await pageRes.text();

			const sid = pageRes.headers.get('set-cookie')?.match(/_sid=([^;]+)/)?.[1];
			const csrfMatch = html.match(/id="csrf-token"[^>]*value="([^"]+)"/);
			const csrf = csrfMatch?.[1];
			const catalogData = extractScript(html, 'catalog-data') as {
				catalog: { filterSessionId: string };
			} | null;
			const filterSessionId = catalogData?.catalog?.filterSessionId;

			if (!sid || !csrf || !filterSessionId) {
				return c.json({ error: 'Could not extract tokens from page' }, 502);
			}
			DEBUG('boardshop', `pagination: csrf=${csrf.slice(0, 8)}..., sid=${sid.slice(0, 8)}...`);

			// Step 2: POST for requested page
			const res = await rateLimitedFetch(BASE_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Cookie: `_sid=${sid}`,
				},
				body: JSON.stringify({ page: pageNum, pageSize: 20, filterSessionId, csrf }),
			});
			if (!res.ok) return c.json({ error: `Pagination returned ${res.status}` }, 502);
			return c.json(withCompleteness(await res.json()));
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// GRAPHQL
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 8: GraphQL with Client-ID auth ────────────────────────
	{
		method: 'GET',
		path: '/graphql-example',
		examples: ['/graphql-example'],
		upstream: ['localhost:4444/sites/streamshop/gql'],
		transport: 'GraphQL',
		description: 'GraphQL query via streamshop. Client-ID from page source.',
		browserRequired: false,
		handler: async (c) => {
			const category = new URL(c.req.url).searchParams.get('category') ?? '';
			const limit = Number(new URL(c.req.url).searchParams.get('limit') ?? '20');
			const CLIENT_ID = 'boardshop_client_abc123xyz';

			const res = await rateLimitedFetch(`${STREAMSHOP_URL}/gql`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Client-ID': CLIENT_ID },
				body: JSON.stringify({
					operationName: 'SearchProducts',
					variables: { limit, ...(category ? { category } : {}) },
				}),
			});
			if (!res.ok) return c.json({ error: `GraphQL returned ${res.status}` }, 502);

			const gql = (await res.json()) as {
				data?: { searchProducts?: { items: unknown[]; totalCount: number } };
			};
			return c.json(gql.data?.searchProducts ?? { items: [], totalCount: 0 });
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// HLS MEDIA
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 9: HLS stream chain — token → playlist → variants ─────
	{
		method: 'GET',
		path: '/hls-example',
		examples: ['/hls-example'],
		upstream: [
			'localhost:4444/sites/streamshop/stream/token',
			'localhost:4444/sites/streamshop/stream/master.m3u8',
		],
		transport: 'HLS/Media',
		description: 'HLS stream: token → master playlist → quality variants.',
		browserRequired: false,
		handler: async (c) => {
			const channel = new URL(c.req.url).searchParams.get('channel') ?? 'boardshop-live';

			// Step 1: Get access token
			const tokenRes = await rateLimitedFetch(
				`${STREAMSHOP_URL}/stream/token?channel=${encodeURIComponent(channel)}`,
			);
			if (!tokenRes.ok) return c.json({ error: `Token returned ${tokenRes.status}` }, 502);
			const tokenData = (await tokenRes.json()) as { signature: string; token: string };

			// Step 2: Fetch master playlist
			const playlistRes = await rateLimitedFetch(
				`${STREAMSHOP_URL}/stream/master.m3u8?sig=${encodeURIComponent(tokenData.signature)}&token=${encodeURIComponent(tokenData.token)}`,
			);
			if (!playlistRes.ok) return c.json({ error: `Playlist returned ${playlistRes.status}` }, 502);
			const playlist = await playlistRes.text();

			// Step 3: Parse quality variants
			const variants: { quality: string; bandwidth: number; url: string }[] = [];
			const lines = playlist.split('\n');
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
					const bw = lines[i].match(/BANDWIDTH=(\d+)/)?.[1];
					const next = lines[i + 1]?.trim();
					if (bw && next && !next.startsWith('#')) {
						variants.push({
							quality: next.replace('.m3u8', '').replace('stream/', ''),
							bandwidth: Number(bw),
							url: next,
						});
					}
				}
			}
			return c.json({ channel, variants, rawPlaylist: playlist });
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// ENCODED API
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 10: Base64-encoded JSON (check X-Encoding header) ─────
	{
		method: 'GET',
		path: '/encoded-example',
		examples: ['/encoded-example'],
		upstream: [
			'localhost:4444/sites/databoard/api/products',
			'localhost:4444/sites/databoard/api/auth/token',
		],
		transport: 'gRPC-Web',
		description: 'Base64-encoded JSON API with Bearer auth.',
		browserRequired: false,
		handler: async (c) => {
			const page = Number(new URL(c.req.url).searchParams.get('page') ?? '1');
			const token = await getDataboardToken();

			const res = await rateLimitedFetch(`${DATABOARD_URL}/api/products?page=${page}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!res.ok) return c.json({ error: `Encoded API returned ${res.status}` }, 502);

			const encoding = res.headers.get('x-encoding');
			const raw = await res.text();
			if (encoding === 'base64') {
				return c.json(withCompleteness(JSON.parse(atob(raw))));
			}
			return c.json(withCompleteness(JSON.parse(raw)));
		},
	},

	// ─── Route 11: MessagePack binary response ───────────────────────
	// Content-Type: application/x-msgpack. Must decode binary format.
	{
		method: 'GET',
		path: '/msgpack-example',
		examples: ['/msgpack-example'],
		upstream: ['localhost:4444/sites/databoard/api/stats'],
		transport: 'Encoded/Binary',
		description: 'MessagePack binary response with Bearer auth.',
		browserRequired: false,
		handler: async (c) => {
			const token = await getDataboardToken();

			const res = await rateLimitedFetch(`${DATABOARD_URL}/api/stats`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!res.ok) return c.json({ error: `Stats API returned ${res.status}` }, 502);

			// MessagePack needs binary decoding. For this reference, we use
			// the @msgpack/msgpack library to decode the response body.
			const { decode } = await import('@msgpack/msgpack');
			const buffer = await res.arrayBuffer();
			const decoded = decode(new Uint8Array(buffer)) as Record<string, unknown>;
			DEBUG('boardshop', `msgpack-example: decoded ${JSON.stringify(decoded).length} chars`);
			return c.json(decoded);
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// CRUMB / TOKEN AUTH
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 12: REST API with crumb from page source ──────────────
	{
		method: 'GET',
		path: '/crumb-example',
		examples: ['/crumb-example?symbol=DECK-001'],
		upstream: ['localhost:4444/sites/liveboard/api/quote/{symbol}'],
		transport: 'JSON API (XHR)',
		description: 'Crumb-authenticated REST API. Token from embedded JSON.',
		browserRequired: false,
		handler: async (c) => {
			const symbol = new URL(c.req.url).searchParams.get('symbol') ?? 'DECK-001';

			// Step 1: Fetch page for session cookie + crumb
			const pageRes = await rateLimitedFetch(LIVEBOARD_URL);
			if (!pageRes.ok) return c.json({ error: `Page returned ${pageRes.status}` }, 502);
			const html = await pageRes.text();
			const sessionCookie = pageRes.headers.get('set-cookie')?.match(/session=([^;]+)/)?.[1];
			const config = extractScript(html, 'app-config') as { crumb: string } | null;
			if (!config || !sessionCookie) return c.json({ error: 'Could not extract crumb' }, 502);

			// Step 2: Call API with crumb + session
			const apiRes = await rateLimitedFetch(
				`${LIVEBOARD_URL}/api/quote/${encodeURIComponent(symbol)}?crumb=${encodeURIComponent(config.crumb)}`,
				{ headers: { Cookie: `session=${sessionCookie}` } },
			);
			if (!apiRes.ok) return c.json({ error: `Quote API returned ${apiRes.status}` }, 502);
			return c.json(await apiRes.json());
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// WEBSOCKET
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 13: WebSocket JSON frames ─────────────────────────────
	// Connect to WS, capture N price updates, return as JSON array.
	// HTTP routes can't stream WS — capture a batch and close.
	{
		method: 'GET',
		path: '/ws-json-example',
		examples: ['/ws-json-example'],
		upstream: ['ws://localhost:4444/sites/liveboard/ws/json'],
		transport: 'WebSocket',
		description: 'WebSocket JSON: capture N real-time price updates.',
		browserRequired: false,
		handler: async (c) => {
			const count = Math.min(Number(new URL(c.req.url).searchParams.get('count') ?? '3'), 10);
			const wsUrl = `${LIVEBOARD_URL.replace('http://', 'ws://')}/ws/json`;

			DEBUG('boardshop', `ws-json: connecting to ${wsUrl}, capturing ${count} updates`);

			const { default: WebSocket } = await import('ws');
			const updates: unknown[] = [];

			const result = await new Promise<unknown[]>((resolve) => {
				const ws = new WebSocket(wsUrl);
				const timeout = setTimeout(() => {
					ws.close();
					resolve(updates);
				}, 10000);

				ws.on('message', (data: Buffer) => {
					const frame = JSON.parse(data.toString()) as Record<string, unknown>;
					if (frame.type === 'price_update' && frame.data) {
						updates.push(frame.data);
						if (updates.length >= count) {
							clearTimeout(timeout);
							ws.close();
							resolve(updates);
						}
					}
				});
				ws.on('error', () => {
					clearTimeout(timeout);
					resolve(updates);
				});
			});

			return c.json({ updates: result, count: result.length, source: wsUrl });
		},
	},

	// ─── Route 14: WebSocket protobuf frames (base64-wrapped) ────────
	// Protobuf frames arrive as JSON { type: "pricing", message: "<base64>" }.
	// The base64 decodes to a protobuf PriceUpdate message.
	{
		method: 'GET',
		path: '/ws-protobuf-example',
		examples: ['/ws-protobuf-example'],
		upstream: ['ws://localhost:4444/sites/liveboard/stream'],
		transport: 'WebSocket',
		description: 'WebSocket protobuf: capture base64-wrapped binary frames.',
		browserRequired: false,
		handler: async (c) => {
			const count = Math.min(Number(new URL(c.req.url).searchParams.get('count') ?? '3'), 10);
			const wsUrl = `${LIVEBOARD_URL.replace('http://', 'ws://')}/stream`;

			DEBUG('boardshop', `ws-protobuf: connecting to ${wsUrl}, capturing ${count} frames`);

			const { default: WebSocket } = await import('ws');
			const frames: { encoded: string; decoded: Record<string, unknown> }[] = [];

			const result = await new Promise<typeof frames>((resolve) => {
				const ws = new WebSocket(wsUrl);
				const timeout = setTimeout(() => {
					ws.close();
					resolve(frames);
				}, 10000);

				ws.on('message', (data: Buffer) => {
					const frame = JSON.parse(data.toString()) as Record<string, unknown>;
					if (frame.type === 'pricing' && typeof frame.message === 'string') {
						// Decode the base64 protobuf — parse raw bytes manually
						// In production, use protobufjs with the schema from /api/schema.proto
						const bytes = Buffer.from(frame.message, 'base64');
						// Quick manual decode: field 1 (string) = sku, field 2 (float) = price
						const decoded: Record<string, unknown> = {
							rawBytes: bytes.length,
							base64: frame.message,
							// A full implementation would use protobufjs here
						};
						frames.push({ encoded: frame.message, decoded });
						if (frames.length >= count) {
							clearTimeout(timeout);
							ws.close();
							resolve(frames);
						}
					}
				});
				ws.on('error', () => {
					clearTimeout(timeout);
					resolve(frames);
				});
			});

			return c.json({ frames: result, count: result.length, source: wsUrl });
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// FRAMEWORK-SPECIFIC EMBEDDED JSON
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 15: __NEXT_DATA__ with Redux state (Next.js pattern) ──
	// Data lives at: props.pageProps.initialReduxState.api.queries
	// Each query key is like "searchResults({})" with a data field inside.
	{
		method: 'GET',
		path: '/nextjs-example',
		examples: ['/nextjs-example'],
		upstream: ['localhost:4444/sites/boardshop/nextjs'],
		transport: 'Embedded JSON',
		description: '__NEXT_DATA__ extraction: navigate Redux RTK Query state tree.',
		browserRequired: false,
		handler: async (c) => {
			const res = await rateLimitedFetch(`${BASE_URL}/nextjs`);
			if (!res.ok) return c.json({ error: `Page returned ${res.status}` }, 502);
			const html = await res.text();

			const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
			if (!match) return c.json({ error: '__NEXT_DATA__ not found' }, 404);

			const nextData = JSON.parse(match[1]) as {
				props: {
					pageProps: {
						initialReduxState: {
							api: {
								queries: Record<string, { status: string; data: unknown }>;
							};
						};
					};
				};
			};

			// Walk the Redux query tree to find the search results
			const queries = nextData.props.pageProps.initialReduxState.api.queries;
			const searchKey = Object.keys(queries).find((k) => k.startsWith('searchResults'));
			const searchData = searchKey ? queries[searchKey].data : null;

			return c.json(withCompleteness(searchData ?? { error: 'No search results query found' }));
		},
	},

	// ─── Route 16: data-deferred-state (deferred state pattern) ────────
	// Data nested deeply: clientData[0][1].data.presentation.searchResults
	// The structure is an array of [controllerName, {data: ...}] tuples.
	{
		method: 'GET',
		path: '/deferred-example',
		examples: ['/deferred-example'],
		upstream: ['localhost:4444/sites/boardshop/deferred'],
		transport: 'Embedded JSON',
		description: 'Deferred state extraction: deep nested array structure.',
		browserRequired: false,
		handler: async (c) => {
			const res = await rateLimitedFetch(`${BASE_URL}/deferred`);
			if (!res.ok) return c.json({ error: `Page returned ${res.status}` }, 502);
			const html = await res.text();

			const match = html.match(/<script id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/);
			if (!match) return c.json({ error: 'Deferred state not found' }, 404);

			const state = JSON.parse(match[1]) as Array<
				[string, { data: { presentation: { searchResults: unknown[]; metadata: unknown } } }]
			>;

			// Navigate the tuple structure: [controllerName, {data: ...}]
			const controller = state[0];
			if (!controller) return c.json({ error: 'No controller data' }, 404);

			const results = controller[1].data.presentation.searchResults;
			const metadata = controller[1].data.presentation.metadata;

			return c.json({ items: results, metadata });
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// QUERY-PARAM METHOD DISPATCH
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 17: POST ?method=X (query param dispatch pattern) ──────────────────
	// Same URL, different ?method= values return different data.
	// Discovered from captured traffic: POST requests all go to the same
	// path but with different method query params.
	{
		method: 'GET',
		path: '/method-example',
		examples: ['/method-example'],
		upstream: ['localhost:4444/sites/boardshop/methods'],
		transport: 'JSON API (XHR)',
		description: 'POST ?method= dispatch: same URL, different operations.',
		browserRequired: false,
		handler: async (c) => {
			const method = new URL(c.req.url).searchParams.get('method') ?? 'GetProducts';
			const category = new URL(c.req.url).searchParams.get('category') ?? '';

			const res = await rateLimitedFetch(
				`${BASE_URL}/methods?method=${encodeURIComponent(method)}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						...(category ? { category } : {}),
						page: 1,
					}),
				},
			);
			if (!res.ok) return c.json({ error: `Method API returned ${res.status}` }, 502);
			return c.json(withCompleteness(await res.json()));
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// BASE64 CURSOR PAGINATION
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 18: Base64-encoded cursor pagination (base64 cursor pattern) ─
	// Cursor is base64(JSON), e.g. eyJvZmZzZXQiOjIwfQ== → {"offset":20}
	// First page: no cursor. Response includes nextCursor for next page.
	{
		method: 'GET',
		path: '/cursor-example',
		examples: ['/cursor-example'],
		upstream: ['localhost:4444/sites/boardshop/catalog/cursor'],
		transport: 'JSON API (XHR)',
		description: 'Base64 cursor pagination: decode/re-encode cursor tokens.',
		browserRequired: false,
		handler: async (c) => {
			const cursor = new URL(c.req.url).searchParams.get('cursor') ?? '';
			const url = `${BASE_URL}/catalog/cursor${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;

			const res = await rateLimitedFetch(url);
			if (!res.ok) return c.json({ error: `Cursor API returned ${res.status}` }, 502);
			return c.json(await res.json());
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// RATE-LIMIT BAIL-OUT
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 19: Rate-limited endpoint with embedded JSON fallback ─
	// The /api/chart/:sku endpoint returns 429 after the first request.
	// Instead of retrying, fall back to embedded JSON from the main page
	// which has the same data. This teaches: bail on 429, find alternatives.
	{
		method: 'GET',
		path: '/chart/:sku',
		examples: ['/chart/DECK-001'],
		upstream: [
			'localhost:4444/sites/boardshop/api/chart/{sku}',
			'localhost:4444/sites/boardshop/product/{sku}',
		],
		transport: 'JSON API (XHR)',
		description: 'Rate-limited chart: tries API first, falls back to embedded JSON.',
		browserRequired: false,
		handler: async (c) => {
			const sku = (c.req.param() as Record<string, string>).sku;

			// Step 1: Try the chart API (will 429 after first call)
			DEBUG('boardshop', `chart: trying API for ${sku}`);
			const apiRes = await rateLimitedFetch(`${BASE_URL}/api/chart/${sku}`);

			if (apiRes.ok) {
				DEBUG('boardshop', `chart: API returned data for ${sku}`);
				return c.json(await apiRes.json());
			}

			if (apiRes.status === 429) {
				// Step 2: BAIL — don't retry. Fall back to embedded JSON.
				DEBUG('boardshop', `chart: 429 — falling back to embedded JSON for ${sku}`);
				const pageRes = await rateLimitedFetch(`${BASE_URL}/product/${sku}`);
				if (!pageRes.ok) return c.json({ error: `Fallback page returned ${pageRes.status}` }, 502);
				const html = await pageRes.text();
				const data = extractScript(html, 'product-data') as {
					product: Record<string, unknown>;
				} | null;
				if (!data) return c.json({ error: 'Fallback embedded JSON not found' }, 404);
				return c.json({
					...data.product,
					_source: 'embedded-json-fallback',
					_note: 'Chart API rate-limited. Data from product page embedded JSON.',
				});
			}

			return c.json({ error: `Chart API returned ${apiRes.status}` }, 502);
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// HYDRATION-STRIPPED EMBEDDED JSON
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 20: Hydrated page — script tags removed by JS ─────────
	// React/Vue/Svelte hydration removes <script type="application/json">
	// from the DOM after reading the data. If you use page.evaluate() to
	// get document.outerHTML AFTER hydration, the data is gone.
	// Fix: fetch the raw HTML with rateLimitedFetch (before JS runs).
	{
		method: 'GET',
		path: '/hydrated-example',
		examples: ['/hydrated-example'],
		upstream: ['localhost:4444/sites/boardshop/hydrated'],
		transport: 'Embedded JSON',
		description: 'Hydrated page: script tags stripped by JS. Use raw HTTP, not DOM.',
		browserRequired: false,
		handler: async (c) => {
			// rateLimitedFetch gets the raw HTML BEFORE JavaScript runs.
			// The <script id="index-data"> is in the response but would be
			// removed from the DOM by the hydration script.
			const res = await rateLimitedFetch(`${BASE_URL}/hydrated`);
			if (!res.ok) return c.json({ error: `Page returned ${res.status}` }, 502);
			const html = await res.text();

			const data = extractScript(html, 'index-data') as {
				events: unknown[];
				totalCount: number;
			} | null;
			if (!data) return c.json({ error: 'index-data not found in raw HTML' }, 404);

			return c.json(data);
		},
	},

	// ─── Route 21: SvelteKit data-sveltekit-fetched (SvelteKit fetched data pattern) ──
	// SvelteKit wraps fetched data in an extra JSON envelope:
	// {"status":200,"body":"\"stringified-json\""}
	// You must unwrap twice: parse the outer JSON, then parse body.
	{
		method: 'GET',
		path: '/sveltekit-example',
		examples: ['/sveltekit-example'],
		upstream: ['localhost:4444/sites/boardshop/sveltekit'],
		transport: 'Embedded JSON',
		description: 'SvelteKit fetched data: JSON-wrapped responses with double parse.',
		browserRequired: false,
		handler: async (c) => {
			const res = await rateLimitedFetch(`${BASE_URL}/sveltekit`);
			if (!res.ok) return c.json({ error: `Page returned ${res.status}` }, 502);
			const html = await res.text();

			// Find all data-sveltekit-fetched script tags
			const matches = html.matchAll(
				/<script[^>]*data-sveltekit-fetched[^>]*>([\s\S]*?)<\/script>/g,
			);

			const results: unknown[] = [];
			for (const match of matches) {
				try {
					// Outer parse: {"status":200,"body":"..."}
					const envelope = JSON.parse(match[1]) as { status: number; body: string };
					// Inner parse: the body is a stringified JSON value
					const data = JSON.parse(envelope.body);
					results.push(data);
				} catch {
					// skip malformed
				}
			}

			return c.json({ fetched: results, count: results.length });
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// JSONP CALLBACK
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 22: JSONP callback wrapper ────────────────────────────
	// Response is JavaScript: callback([data]). Strip the wrapper to
	// get the JSON. Common in autocomplete/suggest APIs.
	{
		method: 'GET',
		path: '/jsonp-example',
		examples: ['/jsonp-example?q=deck'],
		upstream: ['localhost:4444/sites/boardshop/api/suggest'],
		transport: 'JSONP',
		description: 'JSONP: strip callback wrapper to parse JSON.',
		browserRequired: false,
		handler: async (c) => {
			const q = new URL(c.req.url).searchParams.get('q') ?? 'Street';
			const res = await rateLimitedFetch(
				`${BASE_URL}/api/suggest?q=${encodeURIComponent(q)}&callback=parseResults`,
			);
			if (!res.ok) return c.json({ error: `JSONP returned ${res.status}` }, 502);

			const raw = await res.text();
			// Strip JSONP wrapper: parseResults([...]) → [...]
			const jsonStr = raw.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, '');
			const data = JSON.parse(jsonStr) as Array<[string, string]>;

			return c.json({
				suggestions: data.map(([name, sku]) => ({ name, sku })),
				count: data.length,
				query: q,
			});
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// CAPTIONS / TIMED TEXT
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 23: Captions/subtitle extraction ──────────────────────
	// Media sites embed caption URLs in player config. Fetch them
	// separately for structured timed text data.
	{
		method: 'GET',
		path: '/captions-example/:sku',
		examples: ['/captions-example/DECK-001?lang=en'],
		upstream: ['localhost:4444/sites/boardshop/api/captions/{sku}'],
		transport: 'Encoded/Binary',
		description: 'Captions: structured timed text from media endpoint.',
		browserRequired: false,
		handler: async (c) => {
			const sku = (c.req.param() as Record<string, string>).sku;
			const lang = new URL(c.req.url).searchParams.get('lang') ?? 'en';

			const res = await rateLimitedFetch(`${BASE_URL}/api/captions/${sku}?lang=${lang}`);
			if (!res.ok) return c.json({ error: `Captions returned ${res.status}` }, 502);
			return c.json(await res.json());
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// PUBSUB / NOTIFICATION WEBSOCKET
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 24: PubSub notification WebSocket ─────────────────────
	// Secondary WebSocket for push notifications, separate from the
	// main data stream. Common on sites with real-time events.
	{
		method: 'GET',
		path: '/notifications-example',
		examples: ['/notifications-example'],
		upstream: ['ws://localhost:4444/sites/boardshop/ws/notifications'],
		transport: 'WebSocket',
		description: 'PubSub WS: capture push notifications.',
		browserRequired: false,
		handler: async (c) => {
			const count = Math.min(Number(new URL(c.req.url).searchParams.get('count') ?? '3'), 10);
			const wsUrl = 'ws://localhost:4444/sites/boardshop/ws/notifications';

			const { default: WebSocket } = await import('ws');
			const updates: unknown[] = [];

			const result = await new Promise<unknown[]>((resolve) => {
				const ws = new WebSocket(wsUrl);
				const timeout = setTimeout(() => {
					ws.close();
					resolve(updates);
				}, 10000);

				ws.on('message', (data: Buffer) => {
					const frame = JSON.parse(data.toString()) as Record<string, unknown>;
					if (frame.type === 'price_update' && frame.data) {
						updates.push(frame.data);
						if (updates.length >= count) {
							clearTimeout(timeout);
							ws.close();
							resolve(updates);
						}
					}
				});
				ws.on('error', () => {
					clearTimeout(timeout);
					resolve(updates);
				});
			});

			return c.json({ notifications: result, count: result.length, source: wsUrl });
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// GRAPHQL SUBSCRIPTION OVER WEBSOCKET
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 25: GraphQL subscription (graphql-ws protocol) ────────
	// Protocol: connection_init → connection_ack → subscribe → next → complete
	{
		method: 'GET',
		path: '/gql-subscription-example',
		examples: ['/gql-subscription-example'],
		upstream: ['ws://localhost:4444/sites/boardshop/ws/subscriptions'],
		transport: 'WebSocket',
		description: 'GraphQL subscription over WebSocket (graphql-ws protocol).',
		browserRequired: false,
		handler: async (c) => {
			const count = Math.min(Number(new URL(c.req.url).searchParams.get('count') ?? '3'), 10);
			const wsUrl = 'ws://localhost:4444/sites/boardshop/ws/subscriptions';

			const { default: WebSocket } = await import('ws');
			const updates: unknown[] = [];

			const result = await new Promise<unknown[]>((resolve) => {
				const ws = new WebSocket(wsUrl, 'graphql-transport-ws');
				const timeout = setTimeout(() => {
					ws.close();
					resolve(updates);
				}, 15000);

				ws.on('open', () => {
					ws.send(JSON.stringify({ type: 'connection_init' }));
				});

				ws.on('message', (data: Buffer) => {
					const msg = JSON.parse(data.toString()) as Record<string, unknown>;
					if (msg.type === 'connection_ack') {
						ws.send(
							JSON.stringify({
								id: '1',
								type: 'subscribe',
								payload: { query: 'subscription { priceUpdate { sku price change } }' },
							}),
						);
					} else if (msg.type === 'next' && msg.payload) {
						updates.push((msg.payload as { data: unknown }).data);
						if (updates.length >= count) {
							clearTimeout(timeout);
							ws.close();
							resolve(updates);
						}
					} else if (msg.type === 'complete') {
						clearTimeout(timeout);
						ws.close();
						resolve(updates);
					}
				});
				ws.on('error', () => {
					clearTimeout(timeout);
					resolve(updates);
				});
			});

			return c.json({ updates: result, count: result.length, protocol: 'graphql-ws' });
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// CUSTOM BINARY WEBSOCKET FRAMES
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 26: Custom binary frame decoding ──────────────────────
	// Raw binary frames, not JSON. Frame: [type byte][length BE 2 bytes][payload]
	{
		method: 'GET',
		path: '/binary-ws-example',
		examples: ['/binary-ws-example'],
		upstream: ['ws://localhost:4444/sites/boardshop/ws/binary'],
		transport: 'WebSocket',
		description: 'Custom binary WebSocket: decode frame header + payload.',
		browserRequired: false,
		handler: async (c) => {
			const count = Math.min(Number(new URL(c.req.url).searchParams.get('count') ?? '3'), 10);
			const wsUrl = 'ws://localhost:4444/sites/boardshop/ws/binary';

			const { default: WebSocket } = await import('ws');
			const frames: { type: number; payload: unknown }[] = [];

			const result = await new Promise<typeof frames>((resolve) => {
				const ws = new WebSocket(wsUrl);
				const timeout = setTimeout(() => {
					ws.close();
					resolve(frames);
				}, 10000);

				ws.on('message', (data: Buffer) => {
					const buf = Buffer.from(data);
					if (buf.length < 3) return;
					const frameType = buf[0];
					const payloadLen = buf.readUInt16BE(1);
					if (frameType === 0x01 && payloadLen > 0) {
						const payload = JSON.parse(buf.subarray(3, 3 + payloadLen).toString('utf-8'));
						frames.push({ type: frameType, payload });
						if (frames.length >= count) {
							clearTimeout(timeout);
							ws.close();
							resolve(frames);
						}
					}
				});
				ws.on('error', () => {
					clearTimeout(timeout);
					resolve(frames);
				});
			});

			return c.json({ frames: result, count: result.length, source: wsUrl });
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// RSS / XML FEED
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 27: RSS feed parsing with cheerio ─────────────────────
	// Discoverable from <link rel="alternate" type="application/rss+xml">
	// in page HTML. Use cheerio to parse XML — same library handles both
	// HTML and XML. Much more reliable than regex for structured documents.
	{
		method: 'GET',
		path: '/rss-example',
		examples: ['/rss-example'],
		upstream: ['localhost:4444/sites/boardshop/rss'],
		transport: 'HTML-over-the-wire',
		description: 'RSS feed: parse XML with cheerio.',
		browserRequired: false,
		handler: async (c) => {
			const res = await rateLimitedFetch(`${BASE_URL}/rss`);
			if (!res.ok) return c.json({ error: `RSS returned ${res.status}` }, 502);
			const xml = await res.text();

			const { load } = await import('cheerio');
			const $ = load(xml, { xml: true });

			const items = $('item')
				.map((_, el) => ({
					title: $(el).find('title').text(),
					link: $(el).find('link').text(),
					description: $(el).find('description').text(),
					guid: $(el).find('guid').text(),
				}))
				.get();

			return c.json({
				title: $('channel > title').text(),
				description: $('channel > description').text(),
				items,
				count: items.length,
			});
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// SSR HTML TABLE PARSING
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 28: Pure SSR HTML table extraction with cheerio ────────
	// For sites with NO embedded JSON (all data in rendered HTML tables).
	// This is transport (g) SSR — the last resort when no network
	// request carries the data. Use cheerio to parse the HTML DOM.
	{
		method: 'GET',
		path: '/ssr-example',
		examples: ['/ssr-example'],
		upstream: ['localhost:4444/sites/boardshop/ssr'],
		transport: 'HTML-over-the-wire',
		description: 'SSR HTML: parse table rows with cheerio.',
		browserRequired: false,
		handler: async (c) => {
			const page = new URL(c.req.url).searchParams.get('page') ?? '1';
			const res = await rateLimitedFetch(`${BASE_URL}/ssr?page=${page}`);
			if (!res.ok) return c.json({ error: `SSR page returned ${res.status}` }, 502);
			const html = await res.text();

			const { load } = await import('cheerio');
			const $ = load(html);

			const products = $('tr.product-row')
				.map((_, row) => ({
					sku: $(row).attr('data-sku'),
					name: $(row).find('td.name').text(),
					brand: $(row).find('td.brand').text(),
					category: $(row).find('td.category').text(),
					price: $(row).find('td.price').text(),
					stock: Number($(row).find('td.stock').text()),
					rating: $(row).find('td.rating').text(),
				}))
				.get();

			// Discover pagination from <a rel="next">
			const nextLink = $('a[rel="next"]').attr('href');

			return c.json({ products, count: products.length, nextPage: nextLink ?? null });
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// FORMDATA POST
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 29: FormData POST search ──────────────────────────────
	// Some sites send search as multipart/form-data instead of JSON.
	// Discovered from captured traffic where Content-Type is
	// multipart/form-data, not application/json.
	{
		method: 'GET',
		path: '/formdata-search-example',
		examples: ['/formdata-search-example?q=deck'],
		upstream: ['localhost:4444/sites/boardshop/search/form'],
		transport: 'Form-encoded POST',
		description: 'FormData POST: multipart search request.',
		browserRequired: false,
		handler: async (c) => {
			const q = new URL(c.req.url).searchParams.get('q') ?? 'deck';
			const formBody = new URLSearchParams({ query: q, searchType: 'all' });

			const res = await rateLimitedFetch(`${BASE_URL}/search/form`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: formBody.toString(),
			});
			if (!res.ok) return c.json({ error: `Search returned ${res.status}` }, 502);
			return c.json(await res.json());
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// SESSION HARVESTER — Pattern A: httpOnly Cookie + Correlation Header (httpOnly cookie)
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 30: Pro Drops inventory (SessionHarvester pattern) ────
	// The /drops page sets an httpOnly `drop-session` cookie and embeds
	// API keys in window.__DROPS_CONFIG__. The inventory API requires:
	//   1. drop-session cookie (httpOnly — only obtainable via browser/fetch)
	//   2. x-drop-request header (correlation ID, any non-empty value)
	//   3. apikey + apisecret in query params
	// Pattern: fetch the page, harvest the httpOnly cookie + embedded
	// config, then call the session-gated API with harvested values.
	{
		method: 'GET',
		path: '/drops/inventory',
		examples: ['/drops/inventory?deckId=DECK-001'],
		upstream: [
			'localhost:4444/sites/boardshop/drops',
			'localhost:4444/sites/boardshop/drops/api/inventory',
		],
		transport: 'JSON API (XHR)',
		description: 'SessionHarvester (httpOnly cookie): httpOnly cookie + correlation header.',
		browserRequired: false,
		handler: async (c) => {
			const deckId = new URL(c.req.url).searchParams.get('deckId') ?? 'DROP-001';

			// Step 1: HARVEST — fetch the seed page to get httpOnly cookie + API keys
			DEBUG('boardshop', `drops: harvesting session from ${BASE_URL}/drops`);
			const seedRes = await rateLimitedFetch(`${BASE_URL}/drops`);
			if (!seedRes.ok) return c.json({ error: `Seed page returned ${seedRes.status}` }, 502);

			// Extract httpOnly cookie from Set-Cookie header
			const setCookie = seedRes.headers.get('set-cookie') ?? '';
			const dropSession = setCookie.match(/drop-session=([^;]+)/)?.[1];
			if (!dropSession) return c.json({ error: 'Could not harvest drop-session cookie' }, 502);

			// Extract API keys from embedded window global
			const html = await seedRes.text();
			const configMatch = html.match(/window\.__DROPS_CONFIG__\s*=\s*(\{[^}]+\})/);
			if (!configMatch) return c.json({ error: 'Could not extract __DROPS_CONFIG__' }, 502);
			const config = JSON.parse(configMatch[1]) as { apiKey: string; apiSecret: string };

			// Step 2: PAGINATE — call the session-gated inventory API
			DEBUG('boardshop', `drops: fetching inventory for ${deckId} with harvested session`);
			const allItems: unknown[] = [];
			let offset = 0;
			const limit = 20;
			let hasMore = true;

			while (hasMore) {
				const apiUrl =
					`${BASE_URL}/drops/api/inventory?deckId=${encodeURIComponent(deckId)}` +
					`&limit=${limit}&offset=${offset}` +
					`&apikey=${encodeURIComponent(config.apiKey)}&apisecret=${encodeURIComponent(config.apiSecret)}`;

				const res = await rateLimitedFetch(apiUrl, {
					headers: {
						Cookie: `drop-session=${dropSession}`,
						'x-drop-request': crypto.randomUUID(),
					},
				});

				if (!res.ok) {
					DEBUG('boardshop', `drops: inventory API returned ${res.status} at offset ${offset}`);
					break;
				}

				const page = (await res.json()) as { items: unknown[]; total: number; hasMore: boolean };
				allItems.push(...page.items);
				hasMore = page.hasMore;
				offset += limit;
			}

			return c.json({
				deckId,
				items: allItems,
				totalCollected: allItems.length,
				_pattern: 'session-harvester-httponly-cookie',
				_note: 'httpOnly cookie + x-drop-request header required. Harvested from seed page.',
			});
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// SESSION HARVESTER — Pattern B: WAF Cookie + POST Pagination (WAF + POST)
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 31: Resale market listings (SessionHarvester pattern) ──
	// The /resale page sets three cookies:
	//   - market-waf: WAF gate (403 without it)
	//   - market-sid: session data (empty results without it)
	//   - market-pref: preferences
	// All three are needed — WAF alone passes the gate but returns
	// empty data (the WAF-pass trap). POST pagination with JSON body.
	{
		method: 'GET',
		path: '/resale/listings',
		examples: ['/resale/listings'],
		upstream: ['localhost:4444/sites/boardshop/resale'],
		transport: 'JSON API (XHR)',
		description: 'SessionHarvester (WAF + POST): WAF + session cookies + POST pagination.',
		browserRequired: false,
		handler: async (c) => {
			// Step 1: HARVEST — fetch the seed page to get all cookies
			DEBUG('boardshop', `resale: harvesting session from ${BASE_URL}/resale`);
			const seedRes = await rateLimitedFetch(`${BASE_URL}/resale`);
			if (!seedRes.ok) return c.json({ error: `Seed page returned ${seedRes.status}` }, 502);

			// Extract all cookies from Set-Cookie headers
			// Note: getSetCookie() returns each Set-Cookie as a separate string
			const rawHeaders = seedRes.headers;
			const cookies: Record<string, string> = {};

			// Parse Set-Cookie headers — handle both single and multiple headers
			const setCookieHeader = rawHeaders.get('set-cookie') ?? '';
			// In Node fetch, multiple Set-Cookie headers are joined with ', '
			// but cookie values can contain commas, so we parse more carefully
			for (const name of ['market-waf', 'market-sid', 'market-pref']) {
				const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
				if (match) cookies[name] = match[1];
			}

			if (!cookies['market-waf'] || !cookies['market-sid']) {
				return c.json(
					{ error: 'Could not harvest required cookies (market-waf + market-sid)' },
					502,
				);
			}

			const cookieStr = Object.entries(cookies)
				.map(([k, v]) => `${k}=${v}`)
				.join('; ');

			// Step 2: PAGINATE — POST with all harvested cookies
			DEBUG('boardshop', 'resale: POST-paginating with harvested cookies');
			const allItems: unknown[] = [];
			let page = 1;
			let hasMore = true;

			while (hasMore && page <= 10) {
				const res = await rateLimitedFetch(`${BASE_URL}/resale`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Cookie: cookieStr,
					},
					body: JSON.stringify({
						Method: 'LoadMoreListings',
						PageSize: 10,
						CurrentPage: page,
						SortBy: 'price',
					}),
				});

				if (!res.ok) {
					DEBUG('boardshop', `resale: POST returned ${res.status} at page ${page}`);
					break;
				}

				const data = (await res.json()) as { items: unknown[]; hasMore: boolean };
				allItems.push(...data.items);
				hasMore = data.hasMore;
				page++;
			}

			return c.json({
				items: allItems,
				totalCollected: allItems.length,
				_pattern: 'session-harvester-waf-post',
				_note: 'WAF cookie alone returns empty data. All session cookies required for data.',
			});
		},
	},

	// ─── Route 32: Collection listings (encoded pricing + session harvest) ─
	// The /collection/:id page embeds first 8 listings with ENCODED prices.
	// API returns priceRef → _embedded.pricing with opaque encoded amounts.
	// Page renders decoded prices ($XX.XX) using decoder in JS bundle.
	//
	// Pattern:
	//   1. Fetch /collection/:id → harvest listing-session cookie
	//   2. Extract API keys from window.__COLLECTION_CONFIG__
	//   3. Fetch JS bundle → find _decodePriceAmount function
	//   4. Call /api/collection/:id/listings with cookie + API keys
	//   5. Join picks[].priceRef → _embedded.pricing[ref]
	//   6. Decode: each char A-J → digit 0-9, result is cents
	//   7. Paginate (offset-based, 20 per page, 30 total per collection)
	{
		method: 'GET',
		path: '/collection/:id/listings',
		examples: ['/collection/COL-001/listings'],
		upstream: [
			'localhost:4444/sites/boardshop/collection/{id}',
			'localhost:4444/sites/boardshop/api/collection/{id}/listings',
		],
		transport: 'JSON API (XHR)',
		description: 'Encoded pricing: session harvest + indirect price refs + JS decode + pagination.',
		browserRequired: false,
		handler: async (c) => {
			const collectionId = c.req.param('id');
			const url = new URL(c.req.url);
			const sort = url.searchParams.get('sort') ?? 'price';

			// Step 1: Harvest session cookie + embedded config from collection page
			const seedUrl = `${BASE_URL}/collection/${collectionId}`;
			DEBUG('boardshop', `route32: fetching seed page ${seedUrl}`);
			const seedRes = await rateLimitedFetch(seedUrl);
			if (!seedRes.ok) {
				return c.json({ error: `Seed page returned ${seedRes.status}` }, 502);
			}

			const listingSession = seedRes.headers
				.get('set-cookie')
				?.match(/listing-session=([^;]+)/)?.[1];
			if (!listingSession) {
				return c.json({ error: 'Could not harvest listing-session cookie' }, 502);
			}

			const html = await seedRes.text();

			// Step 2: Extract API credentials from window.__COLLECTION_CONFIG__
			const configMatch = html.match(/window\.__COLLECTION_CONFIG__\s*=\s*(\{[^}]+\})/);
			if (!configMatch) {
				return c.json({ error: 'Could not find __COLLECTION_CONFIG__' }, 502);
			}
			const config = JSON.parse(configMatch[1]) as {
				apiKey: string;
				apiSecret: string;
				listingsEndpoint: string;
			};

			// Step 3: Decode function found by reading JS bundle at /js/collection-loader.js
			// The decoder: each char A-J maps to digit 0-9 (charCode - 65)
			const decodePriceAmount = (encoded: string): number => {
				return Number(
					encoded
						.split('')
						.map((ch) => String(ch.charCodeAt(0) - 65))
						.join(''),
				);
			};

			// Step 4+5+6+7: Paginate and decode all listings
			type Pick = {
				listingId: string;
				deckName: string;
				size: string;
				colorway: string;
				condition: string;
				priceRef: string;
				availableQty: number;
				sellerTier: string;
			};
			type PricingEntry = { amount: string; fees: string; currency: string };

			const allListings: Array<
				Pick & { price: number; fees: number; total: number; currency: string }
			> = [];
			let offset = 0;
			let hasMore = true;

			while (hasMore) {
				const apiUrl =
					`${BASE_URL}/api/collection/${collectionId}/listings` +
					`?limit=20&offset=${offset}&sort=${sort}` +
					`&apikey=${config.apiKey}&apisecret=${config.apiSecret}`;

				const res = await rateLimitedFetch(apiUrl, {
					headers: { Cookie: `listing-session=${listingSession}` },
				});

				if (!res.ok) {
					DEBUG('boardshop', `route32: API returned ${res.status} at offset ${offset}`);
					break;
				}

				const data = (await res.json()) as {
					picks: Pick[];
					_embedded: { pricing: Record<string, PricingEntry> };
					total: number;
					hasMore: boolean;
				};

				for (const pick of data.picks) {
					const p = data._embedded.pricing[pick.priceRef];
					if (p) {
						const priceCents = decodePriceAmount(p.amount);
						const feesCents = decodePriceAmount(p.fees);
						allListings.push({
							...pick,
							price: priceCents / 100,
							fees: feesCents / 100,
							total: (priceCents + feesCents) / 100,
							currency: p.currency,
						});
					}
				}

				hasMore = data.hasMore;
				offset += data.picks.length;
				DEBUG('boardshop', `route32: ${allListings.length}/${data.total} listings`);
			}

			return c.json({
				collectionId,
				listings: allListings,
				totalCollected: allListings.length,
				_pattern: 'session-harvest-encoded-pricing',
				_note: 'Prices decoded from opaque A-J encoding via JS bundle analysis.',
			});
		},
	},

	// ─── Route 33: Click-intercept pagination (resale "Load More") ────
	// The /resale page has a "Load More Listings" button that fires a POST
	// request when clicked. Instead of harvesting cookies and building the
	// POST manually (Route 31), this route uses Patchright to click the
	// button and intercept the POST responses directly.
	//
	// Pattern:
	//   1. Launch Patchright, navigate to /resale
	//   2. Set up response interception (page.on('response'))
	//   3. Click "Load More Listings" button
	//   4. Intercepted POST response contains { items, total, hasMore }
	//   5. Loop until hasMore === false
	//
	// This is the simplest approach for pages with pagination buttons —
	// the browser handles all cookies, CSRF, and WAF automatically.
	{
		method: 'GET',
		path: '/resale/all',
		examples: ['/resale/all'],
		upstream: ['localhost:4444/sites/boardshop/resale'],
		transport: 'JSON API (XHR)',
		description: 'Click-intercept: Patchright clicks "Load More", intercepts POST responses.',
		browserRequired: false,
		handler: async (c) => {
			const { chromium } = await import('patchright');
			DEBUG('boardshop', 'route33: launching Patchright for click-intercept');

			const ctx = await chromium.launchPersistentContext('', {
				headless: true,
				channel: 'chromium',
				args: ['--disable-blink-features=AutomationControlled'],
			});

			try {
				const page = await ctx.newPage();

				// Collect all POST responses
				type ListingPage = {
					items: unknown[];
					total: number;
					hasMore: boolean;
					currentPage: number;
				};
				const allItems: unknown[] = [];
				let total = 0;

				page.on('response', async (res) => {
					if (res.request().method() === 'POST' && res.status() === 200) {
						try {
							const json = (await res.json()) as ListingPage;
							if (json.items?.length > 0) {
								allItems.push(...json.items);
								total = json.total;
								DEBUG('boardshop', `route33: page ${json.currentPage}: ${json.items.length} items`);
							}
						} catch {
							/* not JSON */
						}
					}
				});

				await page.goto(`${BASE_URL}/resale`);
				await page.waitForTimeout(2000);

				// Get initial embedded items count
				const initialCount = await page.evaluate(
					() => document.querySelectorAll('[data-testid="listing-card"]').length,
				);

				// Click "Load More" until it disappears
				let clicks = 0;
				while (clicks < 20) {
					const btn = page.locator('[data-action="load-more"]');
					if (!(await btn.isVisible().catch(() => false))) break;
					await btn.click();
					await page.waitForTimeout(500);
					clicks++;
				}

				await ctx.close();

				return c.json({
					initialEmbedded: initialCount,
					paginatedItems: allItems,
					totalCollected: initialCount + allItems.length,
					serverTotal: total,
					clicksNeeded: clicks,
					_pattern: 'click-intercept-pagination',
					_note:
						'Patchright clicks "Load More" and intercepts POST responses. No manual cookie harvest needed.',
				});
			} catch (err) {
				await ctx.close().catch(() => {});
				const msg = err instanceof Error ? err.message : String(err);
				return c.json({ error: msg }, 502);
			}
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// CAPTCHA-GATED — Turnstile-shape (invisible widget, mint → submit)
	// ═══════════════════════════════════════════════════════════════════
	//
	// Pattern (real-world analogue: any Cloudflare-Turnstile-protected form):
	//   1. Open the gated page with Patchright.
	//   2. Read the widget container's data-sitekey from the DOM.
	//   3. Trigger the in-page widget to mint a token (window.captchaWidget.execute).
	//   4. POST the token to the verification endpoint.
	//   5. Return the verified payload + the captured token + sitekey for replay.
	//
	// The token shape is `0.<base64url>` — generic Turnstile-style. Production
	// targets will use a real Cloudflare-issued token; the integration shape is
	// identical (mint inside the browser, replay in the next request).
	{
		method: 'GET',
		path: '/captcha-turnstile',
		examples: ['/captcha-turnstile'],
		upstream: ['localhost:4444/sites/turnstile/'],
		transport: 'JSON API (XHR)',
		description: 'Captcha-gated form: mint Turnstile-shape token in browser, submit, verify.',
		browserRequired: false,
		handler: async (c) => {
			const { chromium } = await import('patchright');
			DEBUG('boardshop', 'captcha-turnstile: launching Patchright');

			const ctx = await chromium.launchPersistentContext('', {
				headless: true,
				channel: 'chromium',
				args: ['--disable-blink-features=AutomationControlled'],
			});

			try {
				const page = await ctx.newPage();
				await page.goto(`${TURNSTILE_URL}/`);

				// The widget is a page global, so both the readiness check and the
				// mint have to run in the page's own JavaScript world — page.evaluate
				// is isolated from it and would see `undefined` forever. See
				// packages/browser/src/shared/main-world.ts.
				await page.waitForFunction(() => Boolean(document.querySelector('[data-captcha-widget]')));
				await evaluateInMainWorld(page, () =>
					Boolean((window as unknown as { captchaWidget?: unknown }).captchaWidget),
				);

				const sitekey = await page.evaluate(
					() => document.querySelector<HTMLElement>('[data-captcha-widget]')?.dataset.sitekey ?? '',
				);

				const token = await evaluateInMainWorld(page, async () => {
					const w = (
						window as unknown as {
							captchaWidget: {
								render: (el: Element, opts: { sitekey: string }) => string;
								execute: (id: string) => Promise<string>;
							};
						}
					).captchaWidget;
					const el = document.querySelector('[data-captcha-widget]');
					if (!el) throw new Error('widget not found');
					const sk = (el as HTMLElement).dataset.sitekey ?? '';
					const id = w.render(el, { sitekey: sk });
					return await w.execute(id);
				});

				const verifyRes = await page.evaluate(async (t: string) => {
					const r = await fetch('api/verify', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ token: t }),
					});
					return { status: r.status, body: await r.json().catch(() => null) };
				}, token);

				await ctx.close();

				return c.json({
					sitekey,
					token,
					tokenPrefix: token.slice(0, 2),
					verify: verifyRes,
					_pattern: 'captcha-mint-and-replay',
					_note:
						'Token minted inside the browser via the widget API, then replayed to the verification endpoint. Same shape as a real Turnstile integration.',
				});
			} catch (err) {
				await ctx.close().catch(() => {});
				const msg = err instanceof Error ? err.message : String(err);
				return c.json({ error: msg }, 502);
			}
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// CAPTCHA-GATED — hCaptcha-shape (challenge → proof → JWT-shape token)
	// ═══════════════════════════════════════════════════════════════════
	//
	// Pattern (real-world analogue: any hCaptcha-protected POST endpoint):
	//   1. Open the gated page with Patchright.
	//   2. Listen for the postMessage carrying the minted token.
	//   3. Click the "Send" button — page does challenge → proof → submit.
	//   4. Capture the P1_-prefixed JWT-shape token from postMessage AND from
	//      intercepted /api/check responses (two independent capture paths).
	//   5. Replay the token in x-captcha-token against the protected endpoint.
	{
		method: 'GET',
		path: '/captcha-hcaptcha',
		examples: ['/captcha-hcaptcha'],
		upstream: ['localhost:4444/sites/hcaptcha/'],
		transport: 'JSON API (XHR)',
		description: 'Captcha-gated send: capture P1_-shape token via postMessage, replay in header.',
		browserRequired: false,
		handler: async (c) => {
			const { chromium } = await import('patchright');
			DEBUG('boardshop', 'captcha-hcaptcha: launching Patchright');

			const ctx = await chromium.launchPersistentContext('', {
				headless: true,
				channel: 'chromium',
				args: ['--disable-blink-features=AutomationControlled'],
			});

			try {
				const page = await ctx.newPage();

				let interceptedToken: string | null = null;
				page.on('response', async (res) => {
					if (res.url().includes('/api/check/') && res.status() === 200) {
						try {
							const json = (await res.json()) as { token?: string };
							if (json.token) interceptedToken = json.token;
						} catch {
							/* not JSON */
						}
					}
				});

				await page.goto(`${HCAPTCHA_URL}/`);
				await page.waitForFunction(() =>
					Boolean((window as unknown as { captchaWidget?: unknown }).captchaWidget),
				);

				const sitekey = await page.evaluate(
					() => document.querySelector<HTMLElement>('[data-captcha-widget]')?.dataset.sitekey ?? '',
				);

				// The page posts its token to its own window, and a listener registered
				// through page.evaluate sits in an isolated world that never sees it.
				// Register in the page's world and park the token on the DOM, which
				// both worlds share. See packages/browser/src/shared/main-world.ts.
				const TOKEN_ATTR = 'data-captured-captcha-token';
				await evaluateInMainWorld(
					page,
					(attr: string) => {
						window.addEventListener('message', (ev: MessageEvent) => {
							const data = ev.data as { kind?: string; token?: string };
							if (data?.kind === 'captcha-token' && data.token) {
								document.documentElement.setAttribute(attr, data.token);
							}
						});
						return true;
					},
					TOKEN_ATTR,
				);

				await page.locator('#send-btn').click();

				// Two independent capture paths: the page's postMessage, and the
				// intercepted /api/check response. Either is sufficient.
				const token = await new Promise<string>((resolve, reject) => {
					const t0 = Date.now();
					const iv = setInterval(async () => {
						const posted = await page
							.evaluate((attr: string) => document.documentElement.getAttribute(attr), TOKEN_ATTR)
							.catch(() => null);
						if (posted) {
							clearInterval(iv);
							resolve(posted);
						} else if (interceptedToken) {
							clearInterval(iv);
							resolve(interceptedToken);
						} else if (Date.now() - t0 > 10_000) {
							clearInterval(iv);
							reject(new Error('token capture timed out'));
						}
					}, 100);
				});

				// Replay: hit /api/submit from a clean fetch context using the captured token.
				const replay = await page.evaluate(async (t: string) => {
					const r = await fetch('api/submit', {
						method: 'POST',
						headers: { 'content-type': 'application/json', 'x-captcha-token': t },
						body: JSON.stringify({ message: 'replay' }),
					});
					return { status: r.status, body: await r.json().catch(() => null) };
				}, token);

				await ctx.close();

				return c.json({
					sitekey,
					token,
					tokenPrefix: token.slice(0, 3),
					replay,
					_pattern: 'captcha-postmessage-capture-and-replay',
					_note:
						'Token captured from the in-page postMessage event, then replayed in the x-captcha-token header. Same shape as a real hCaptcha integration.',
				});
			} catch (err) {
				await ctx.close().catch(() => {});
				const msg = err instanceof Error ? err.message : String(err);
				return c.json({ error: msg }, 502);
			}
		},
	},
	// ─── Transports a JSON-first scan reports as absent ──────────────────
	// Each of the seven routes below consumes a transport the elimination table
	// asks a verdict on and nothing here used to demonstrate. They exist to be
	// read: a row is only answerable by someone who knows what it looks like
	// when present.
	{
		method: 'GET',
		path: '/sse-example',
		examples: ['/sse-example'],
		upstream: ['localhost:4444/sites/newsboard/live/points'],
		transport: 'SSE',
		description: 'Server-Sent Events. Reads an event stream to completion and returns the events.',
		browserRequired: false,
		handler: async (c) => {
			// SSE is a plain GET at the wire — same method, same status, and a body
			// that arrives in pieces. Only the content type and the framing tell it
			// apart, which is why a capture that classifies by method alone files
			// this under "a slow JSON endpoint" and the row reads absent.
			const res = await rateLimitedFetch(`${NEWSBOARD_URL}/live/points`, {
				headers: { accept: 'text/event-stream' },
			});
			if (!res.ok) return c.json({ error: `Stream returned ${res.status}` }, 502);

			const contentType = res.headers.get('content-type') ?? '';
			if (!contentType.includes('text/event-stream')) {
				// A server that answered with JSON did not give us the transport we
				// asked for, and reporting its body as stream events would be a lie.
				return c.json({ error: `Expected text/event-stream, got ${contentType}` }, 502);
			}

			// Frames are separated by a blank line; each carries optional `event:`
			// and one or more `data:` lines.
			const events = (await res.text())
				.split('\n\n')
				.filter(Boolean)
				.map((frame) => {
					const name = frame.match(/^event: (.+)$/m)?.[1] ?? 'message';
					const data = [...frame.matchAll(/^data: (.*)$/gm)].map((m) => m[1]).join('\n');
					let parsed: unknown = data;
					try {
						parsed = JSON.parse(data);
					} catch {
						/* a non-JSON frame is still an event */
					}
					return { event: name, data: parsed };
				});

			// The helper derives the signal from the body, so the body has to carry the
			// indicated total for it to have anything to compare against.
			return c.json(withCompleteness({ events, total: events.length }));
		},
	},
	{
		method: 'GET',
		path: '/longpoll-example',
		examples: ['/longpoll-example'],
		upstream: ['localhost:4444/sites/newsboard/poll/updates'],
		transport: 'JSON API (XHR)',
		description: 'Long-poll. A GET that represents a stream, one round at a time.',
		browserRequired: false,
		handler: async (c) => {
			// The trap this exists to teach: a long-poll is a GET returning JSON, so
			// every scan classifies it as an ordinary endpoint and "no WebSocket"
			// gets written down as "no realtime". What marks it is the loop — the
			// response says to ask again, and the client immediately does.
			const rounds = Math.min(Number(c.req.query('rounds') ?? '2'), 5);
			const updates: unknown[] = [];
			let since: string | null = null;

			for (let i = 0; i < rounds; i++) {
				const url = `${NEWSBOARD_URL}/poll/updates${since ? `?since=${encodeURIComponent(since)}` : ''}`;
				const res = await rateLimitedFetch(url);
				if (!res.ok) return c.json({ error: `Poll returned ${res.status}` }, 502);
				const body = (await res.json()) as { updates?: unknown[]; reconnect?: boolean };
				updates.push(...(body.updates ?? []));
				since = String(Date.now());
				if (!body.reconnect) break;
			}

			return c.json({ updates, rounds, _pattern: 'long-poll: response invites the next request' });
		},
	},
	{
		method: 'GET',
		path: '/fragment-example',
		examples: ['/fragment-example?page=2'],
		upstream: ['localhost:4444/sites/newsboard/fragment/stories'],
		transport: 'HTML-over-the-wire',
		description: 'HTML fragment response. The body is markup meant for the DOM, not JSON.',
		browserRequired: false,
		handler: async (c) => {
			const page = Number(c.req.query('page') ?? '2');
			const res = await rateLimitedFetch(`${NEWSBOARD_URL}/fragment/stories?page=${page}`);
			if (!res.ok) return c.json({ error: `Fragment returned ${res.status}` }, 502);

			// The response is markup, so the data has to be read out of attributes.
			// A JSON-shaped scan finds no payload here and files the endpoint as a
			// page rather than as data — the row's whole failure mode.
			const html = await res.text();
			const items = [...html.matchAll(/<news-story\b([^>]*)>/g)].map((m) => {
				const attrs: Record<string, string> = {};
				for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
				return attrs;
			});

			return c.json(withCompleteness({ items, total: items.length }));
		},
	},
	{
		method: 'GET',
		path: '/attributes-example',
		examples: ['/attributes-example'],
		upstream: ['localhost:4444/sites/newsboard/'],
		transport: 'Embedded JSON',
		description: 'Server-rendered data held in HTML attributes rather than a JSON blob.',
		browserRequired: false,
		handler: async (c) => {
			// Distinct from every other embedded shape: there is no script tag and no
			// hydration payload. The record is spread across attributes on a custom
			// element, so a scan looking for `__NEXT_DATA__` or an application/json
			// block reports the page as carrying no data while every field is present.
			const res = await rateLimitedFetch(`${NEWSBOARD_URL}/`);
			if (!res.ok) return c.json({ error: `Page returned ${res.status}` }, 502);
			const html = await res.text();

			const stories = [...html.matchAll(/<news-story\b([^>]*)>/g)].map((m) => {
				const a: Record<string, string> = {};
				for (const kv of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[kv[1]] = kv[2];
				return {
					id: Number(a['story-id']),
					title: a['data-title'],
					author: a.author,
					points: Number(a.points),
					comments: Number(a['comment-count']),
				};
			});

			return c.json(
				withCompleteness({ stories, total: stories.length, _pattern: 'data-in-attributes' }),
			);
		},
	},
	{
		method: 'GET',
		path: '/worker-example',
		examples: ['/worker-example'],
		upstream: [
			'localhost:4444/sites/newsboard/worker.js',
			'localhost:4444/sites/newsboard/api/trending',
		],
		transport: 'Worker-scoped',
		description: 'Traffic a worker makes from its own scope, reached by reading its source.',
		browserRequired: false,
		handler: async (c) => {
			// A worker gets its own global scope, so nothing patched in the page sees
			// its requests and capture attributes them to no initiator. The way in is
			// the worker source itself: read the endpoints out of it, then call them.
			const src = await (await rateLimitedFetch(`${NEWSBOARD_URL}/worker.js`)).text();
			const endpoints = [...src.matchAll(/fetch\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
			if (!endpoints.length) {
				return c.json({ error: 'Worker source declared no endpoints' }, 502);
			}

			const results = [];
			for (const path of endpoints) {
				const res = await rateLimitedFetch(new URL(path, `${NEWSBOARD_URL}/`).toString());
				results.push({ endpoint: path, status: res.status, data: await res.json() });
			}

			return c.json({ endpoints, results, _pattern: 'worker-source-to-endpoint' });
		},
	},
	{
		method: 'GET',
		path: '/crossframe-example',
		examples: ['/crossframe-example'],
		upstream: [
			'localhost:4444/sites/newsboard/widget',
			'localhost:4444/sites/newsboard/api/trending',
		],
		transport: 'Cross-frame RPC',
		description: 'An iframe that fetches on the page behalf and replies over postMessage.',
		browserRequired: false,
		handler: async (c) => {
			// The host page never calls the API — the frame does, and answers over
			// postMessage. Watching the top frame shows a message with no request
			// behind it, so the endpoint looks like it does not exist. The frame
			// source is where it becomes visible.
			const src = await (await rateLimitedFetch(`${NEWSBOARD_URL}/widget`)).text();
			const endpoint = src.match(/fetch\(\s*['"]([^'"]+)['"]/)?.[1];
			if (!endpoint) return c.json({ error: 'Frame source declared no endpoint' }, 502);

			const res = await rateLimitedFetch(new URL(endpoint, `${NEWSBOARD_URL}/`).toString());
			if (!res.ok) return c.json({ error: `Frame endpoint returned ${res.status}` }, 502);

			return c.json({
				frame: '/widget',
				endpoint,
				data: await res.json(),
				_pattern: 'iframe-fetches-parent-receives',
			});
		},
	},
	{
		method: 'GET',
		path: '/beacon-example',
		examples: ['/beacon-example'],
		upstream: ['localhost:4444/sites/newsboard/collect', 'localhost:4444/sites/newsboard/px.gif'],
		transport: 'Beacon/Telemetry',
		description: 'Outbound telemetry. Reported so a coverage count can explain it, not consume it.',
		browserRequired: false,
		handler: async (c) => {
			// Beacons carry data out rather than fetching it in, so there is nothing
			// here to wrap in a route. They earn a row anyway: every one shows up in
			// a capture, and an endpoint left unexplained reads as a coverage gap.
			// Naming them is what keeps the recall number honest.
			const probes = [
				{ endpoint: '/collect', method: 'POST', kind: 'sendBeacon' },
				{ endpoint: '/px.gif', method: 'GET', kind: 'image-pixel' },
			];
			const observed = [];
			for (const p of probes) {
				const res = await rateLimitedFetch(`${NEWSBOARD_URL}${p.endpoint}`, {
					method: p.method,
					...(p.method === 'POST' ? { body: 'probe=1' } : {}),
				});
				observed.push({ ...p, status: res.status, carriesData: false });
			}
			return c.json({
				telemetry: observed,
				_pattern: 'egress-not-ingress',
				_note:
					'Telemetry endpoints are explained in the coverage diff, never wrapped as data routes.',
			});
		},
	},
	{
		method: 'GET',
		path: '/peer-example',
		examples: ['/peer-example'],
		upstream: ['localhost:4444/sites/newsboard/'],
		transport: 'WebRTC',
		description:
			'Peer transports the page constructs. Reports the attempt, never fakes a connection.',
		browserRequired: false,
		handler: async (c) => {
			// WebRTC and WebTransport need a signalling peer and an HTTP/3 endpoint,
			// neither of which exists here — and neither can be reached from a server
			// anyway. The elimination row asks what the page reached for, and that is
			// answerable from the source. Reporting the construction is the honest
			// result; returning invented channel data would not be.
			const html = await (await rateLimitedFetch(`${NEWSBOARD_URL}/`)).text();
			const constructed = [
				{
					api: 'RTCPeerConnection',
					transport: 'WebRTC',
					present: /new RTCPeerConnection/.test(html),
				},
				{ api: 'WebTransport', transport: 'WebTransport', present: /new WebTransport/.test(html) },
			];
			return c.json({
				constructed,
				connected: false,
				_pattern: 'construction-observed-not-connection',
				_note:
					'A peer transport is verdicted from what the page constructs; the session itself is out of reach from a route.',
			});
		},
	},
	{
		method: 'GET',
		path: '/webtransport-example',
		examples: ['/webtransport-example'],
		upstream: ['localhost:4444/sites/newsboard/'],
		transport: 'WebTransport',
		description: 'WebTransport the page constructs. Reports the attempt, never fakes a session.',
		browserRequired: false,
		handler: async (c) => {
			// WebTransport needs HTTP/3, which no route can speak and this fixture
			// does not serve. That makes the row answerable only from what the page
			// reached for — and answering it that way is the correct outcome, not a
			// degraded one. Give-up is a reported result; invented stream data is not.
			const html = await (await rateLimitedFetch(`${NEWSBOARD_URL}/`)).text();
			const constructed = /new WebTransport/.test(html);
			return c.json({
				api: 'WebTransport',
				constructed,
				connected: false,
				reason: constructed
					? 'Page constructs a WebTransport; the session needs HTTP/3 and is out of reach from a route.'
					: 'Page never constructs a WebTransport.',
				_pattern: 'construction-observed-not-connection',
			});
		},
	},
	{
		method: 'GET',
		path: '/serviceworker-example',
		examples: ['/serviceworker-example'],
		upstream: ['localhost:4444/sites/newsboard/sw.js'],
		transport: 'Service Worker',
		description: 'Which requests a service worker shadows, read from its source.',
		browserRequired: false,
		handler: async (c) => {
			// A registered service worker can answer a fetch from cache, so a request
			// the page makes may never reach the network at all. Capture then shows a
			// gap that looks like the endpoint does not exist. Reading the worker
			// source says which URLs it intercepts, which is what turns that gap into
			// an explanation.
			const res = await rateLimitedFetch(`${NEWSBOARD_URL}/sw.js`);
			if (!res.ok) return c.json({ error: `Worker source returned ${res.status}` }, 502);
			const src = await res.text();

			const handlesFetch = /addEventListener\(\s*['"]fetch['"]/.test(src);
			const cached = [...src.matchAll(/cache\.(?:add|put|match)\(\s*['"]([^'"]+)['"]/g)].map(
				(m) => m[1],
			);

			return c.json({
				source: '/sw.js',
				handlesFetch,
				cachedRoutes: cached,
				_pattern: 'service-worker-shadows-the-network',
				_note: handlesFetch
					? 'This worker intercepts fetch, so a captured gap may be a cache hit rather than a missing endpoint.'
					: 'This worker does not intercept fetch; captured traffic is complete.',
			});
		},
	},
	{
		method: 'GET',
		path: '/semantic-example',
		examples: ['/semantic-example'],
		upstream: ['localhost:4444/sites/newsboard/semantic'],
		transport: 'Embedded JSON',
		description:
			'Structured data held in standards — JSON-LD, Open Graph — not in a framework payload.',
		browserRequired: false,
		handler: async (c) => {
			// The third shape of data-in-markup, and the one a scan for framework
			// markers never finds. Hydration payloads are framework internals
			// (`__NEXT_DATA__`, `__NUXT__`); element attributes are the page's own
			// convention; this is neither. It is standardised, so it can be read
			// without knowing what built the page — and it is on a large share of
			// the web because search engines ask for it. A page reporting "no
			// embedded data" against framework markers alone routinely carries the
			// whole record right here.
			const res = await rateLimitedFetch(`${NEWSBOARD_URL}/semantic`);
			if (!res.ok) return c.json({ error: `Page returned ${res.status}` }, 502);
			const html = await res.text();

			// JSON-LD: one or more <script type="application/ld+json"> blocks. A page
			// may carry several — a breadcrumb list beside the thing you want — so
			// collect them all rather than taking the first.
			const jsonLd: unknown[] = [];
			for (const m of html.matchAll(
				/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
			)) {
				try {
					jsonLd.push(JSON.parse(m[1]));
				} catch {
					// A malformed block is a fact about the page, not a reason to abandon
					// the rest of them.
				}
			}

			// Open Graph and Twitter cards: flat, and often the only place a title or
			// canonical URL is stated without JavaScript.
			const meta: Record<string, string> = {};
			for (const m of html.matchAll(
				/<meta[^>]+(?:property|name)=["'](og:[^"']+|twitter:[^"']+)["'][^>]+content=["']([^"']*)["']/gi,
			)) {
				meta[m[1]] = m[2];
			}

			// Flatten the item list, which is the shape most listing pages use.
			const list = jsonLd.find((d) => (d as { '@type'?: string })?.['@type'] === 'ItemList') as
				| { itemListElement?: Array<Record<string, unknown>>; numberOfItems?: number }
				| undefined;
			const items = (list?.itemListElement ?? []).map((el) => ({
				position: el.position,
				title: el.headline,
				author: (el.author as { name?: string } | undefined)?.name,
				points: (el.interactionStatistic as { userInteractionCount?: number } | undefined)
					?.userInteractionCount,
			}));

			return c.json(
				withCompleteness({
					items,
					total: list?.numberOfItems ?? items.length,
					meta,
					_pattern: 'semantic-markup',
				}),
			);
		},
	},
	{
		method: 'GET',
		path: '/stream-example',
		examples: ['/stream-example'],
		upstream: ['localhost:4444/sites/newsboard/stream/stories'],
		transport: 'Streaming response',
		description:
			'A body read as it arrives. NDJSON over a plain GET — a stream only in how it is consumed.',
		browserRequired: false,
		handler: async (c) => {
			// At the wire this is indistinguishable from any other GET: same method,
			// same status, a body that happens to arrive in pieces. What makes it a
			// stream is the caller reading it incrementally, which is why a capture
			// recording request starts files a live feed as a slow endpoint. Reading
			// it whole here is correct for a route — the point is that the transport
			// is recognisable at all.
			const res = await rateLimitedFetch(`${NEWSBOARD_URL}/stream/stories`);
			if (!res.ok) return c.json({ error: `Stream returned ${res.status}` }, 502);

			const contentType = res.headers.get('content-type') ?? '';
			const lines = (await res.text()).split('\n').filter(Boolean);
			const items = lines.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					// One malformed record is a fact about the feed, not a reason to
					// discard the rest of it.
					return { _unparsed: line.slice(0, 120) };
				}
			});

			return c.json(
				withCompleteness({ items, total: items.length, contentType, _pattern: 'ndjson-stream' }),
			);
		},
	},
	{
		method: 'GET',
		path: '/polling-example',
		examples: ['/polling-example'],
		upstream: ['localhost:4444/sites/newsboard/poll/updates'],
		transport: 'Polling/Long-poll',
		description: 'A stream wearing a request costume: the same call on a cadence.',
		browserRequired: false,
		handler: async (c) => {
			// Nothing about one of these requests shows what it is. The tell is the
			// cadence — the same call shape repeating, each response inviting the
			// next — so a site whose realtime feed is a long-poll gets recorded as
			// having no realtime transport at all unless something watches over time.
			const rounds = Math.min(Number(c.req.query('rounds') ?? '3'), 5);
			const updates: unknown[] = [];
			const gaps: number[] = [];
			let since: string | null = null;
			let last = Date.now();

			for (let i = 0; i < rounds; i++) {
				const url = `${NEWSBOARD_URL}/poll/updates${since ? `?since=${encodeURIComponent(since)}` : ''}`;
				const res = await rateLimitedFetch(url);
				if (!res.ok) return c.json({ error: `Poll returned ${res.status}` }, 502);
				const body = (await res.json()) as { updates?: unknown[]; reconnect?: boolean };
				updates.push(...(body.updates ?? []));
				gaps.push(Date.now() - last);
				last = Date.now();
				since = String(Date.now());
				if (!body.reconnect) break;
			}

			return c.json({
				updates,
				rounds: gaps.length,
				gapsMs: gaps,
				_pattern: 'cadence-is-the-tell',
			});
		},
	},
	{
		method: 'GET',
		path: '/player-example/:videoId',
		examples: ['/player-example/demo'],
		upstream: ['localhost:4444/sites/newsboard/player'],
		transport: 'HLS/Media',
		description:
			'Media a route cannot fetch: formats described without URLs, so the player is the API.',
		browserRequired: true,
		handler: async (c, browser) => {
			// The shape a large video site actually serves: a list of formats with an
			// id, a codec and a byte length, and no URL on any of them, because the
			// media is negotiated separately. There is nothing to fetch and nothing
			// to replay. A route that returned the empty URL list would read as "this
			// video has no formats", which is a different and wrong fact — so the
			// give-up is reported, and control of the real player is offered instead.
			await browser.navigate(`${NEWSBOARD_URL}/player`);
			await new Promise((r) => setTimeout(r, 3500));

			// Read out of the DOM, not off the page's globals. `evaluate` runs in an
			// isolated world that shares the DOM and not the globals, so reaching for
			// `window.playerResponse` returns undefined with nothing thrown — the
			// element resolves, the data does not, and the page appears to have no
			// formats. The markup is common ground, so the script tag can be read
			// from either side. That is also more robust than the bridge here: no
			// injection, so a content-security policy cannot refuse it.
			const info = (await browser.evaluate(
				new Function(`return (() => {
					const m = document.documentElement.innerHTML.match(/window\\.playerResponse\\s*=\\s*(\\{[\\s\\S]*?\\});/);
					let pr = {};
					if (m) { try { pr = JSON.parse(m[1]); } catch (e) { pr = {}; } }
					const fmts = (pr.streamingData || {}).adaptiveFormats || [];
					const v = document.querySelector('video');
					return {
						playability: (pr.playabilityStatus || {}).status || null,
						formats: fmts.map((f) => ({
							itag: f.itag, mimeType: f.mimeType,
							quality: f.qualityLabel || f.audioQuality,
							contentLength: f.contentLength,
							hasUrl: !!f.url, hasCipher: !!f.signatureCipher,
						})),
						player: v ? { duration: +(v.duration || 0).toFixed(2), paused: v.paused, readyState: v.readyState } : null,
					};
				})()`) as never,
			)) as { formats?: Array<{ hasUrl?: boolean }>; player?: unknown; playability?: string };

			const fetchable = (info.formats ?? []).filter((f) => f.hasUrl).length;
			return c.json({
				videoId: (c.req.param() as Record<string, string>).videoId,
				playability: info.playability ?? null,
				formats: info.formats ?? [],
				directlyFetchable: fetchable,
				player: info.player ?? null,
				_pattern: 'described-not-addressed',
				_note:
					fetchable > 0
						? 'Some formats carry a URL and can be fetched.'
						: 'No format carries a URL. The media cannot be fetched or replayed — drive the player instead, which is what the control route demonstrates.',
			});
		},
	},
	{
		method: 'POST',
		path: '/player-example/:videoId/control',
		examples: ['/player-example/demo/control'],
		upstream: ['localhost:4444/sites/newsboard/player'],
		transport: 'HLS/Media',
		description: 'Play, pause and seek the real player, then report the state it reached.',
		browserRequired: true,
		handler: async (c, browser) => {
			// Named actions rather than a script from the request body: a caller may
			// drive playback and may not reach past it into the page.
			const body = (await c.req.json().catch(() => ({}))) as { action?: string; seconds?: number };
			const action = String(body.action ?? 'state');
			const scripts: Record<string, string> = {
				play: `document.querySelector('video').play()`,
				pause: `document.querySelector('video').pause()`,
				seek: `document.querySelector('video').currentTime = ${Number(body.seconds ?? 0)}`,
				state: '0',
			};
			if (!(action in scripts)) {
				return c.json({ error: `Unknown action "${action}"`, allowed: Object.keys(scripts) }, 400);
			}

			if (!browser.getUrl().includes('/newsboard/player')) {
				await browser.navigate(`${NEWSBOARD_URL}/player`);
				await new Promise((r) => setTimeout(r, 3500));
			}
			await browser.evaluate(new Function(`return ${scripts[action]}`) as never);
			// Play and seek take effect asynchronously; reading before the player has
			// moved would report a state that never existed.
			await new Promise((r) => setTimeout(r, action === 'state' ? 0 : 900));

			const state = await browser.evaluate(
				new Function(`return (() => { const v = document.querySelector('video');
					return v ? { paused: v.paused, currentTime: +v.currentTime.toFixed(2),
						duration: +(v.duration || 0).toFixed(2), readyState: v.readyState } : null; })()`) as never,
			);
			return c.json({ action, ...(state as object), _pattern: 'drive-the-player' });
		},
	},
	{
		method: 'GET',
		path: '/pricing-stream-example',
		examples: ['/pricing-stream-example'],
		upstream: ['localhost:4444/sites/newsboard/pricing/frames'],
		transport: 'Encoded/Binary',
		description: 'Frames whose payload is base64-wrapped binary — noise until decoded.',
		browserRequired: false,
		handler: async (c) => {
			// The shape a real price socket uses. Read as text these frames are
			// gibberish, which is how a stream carrying the most valuable data on a
			// site gets recorded as empty. Decoding is the whole job.
			const res = await rateLimitedFetch(`${NEWSBOARD_URL}/pricing/frames`);
			if (!res.ok) return c.json({ error: `Frames returned ${res.status}` }, 502);
			const body = (await res.json()) as { frames?: Array<{ message?: string }> };

			const decoded = (body.frames ?? []).map((f) => {
				const buf = Buffer.from(String(f.message ?? ''), 'base64');
				const out: Record<string, unknown> = {};
				let i = 0;
				try {
					while (i < buf.length) {
						const key = buf[i++];
						const field = key >> 3;
						const wire = key & 7;
						if (wire === 2) {
							const len = buf[i++];
							out[field === 1 ? 'id' : `field${field}`] = buf.subarray(i, i + len).toString('utf8');
							i += len;
						} else if (wire === 1) {
							out[field === 2 ? 'price' : `field${field}`] = buf.readDoubleLE(i);
							i += 8;
						} else break;
					}
				} catch {
					// A truncated frame yields what decoded before it ran out.
				}
				return out;
			});

			return c.json(
				withCompleteness({
					frames: decoded,
					total: decoded.length,
					_pattern: 'decode-before-judging',
				}),
			);
		},
	},
];
