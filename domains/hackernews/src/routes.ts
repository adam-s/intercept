/**
 * Hacker News (news.ycombinator.com) API Routes
 *
 * DISCOVERY SUMMARY (see AGENTS.md discovery protocol):
 *
 * news.ycombinator.com is fully server-rendered — every page it returns
 * carries the complete data as HTML, and the "API" a real visitor's browser
 * uses IS the page navigation itself. There is no JSON XHR API for the
 * anonymous, public surface: two manifest --sweep passes (front page, a
 * 204-comment item page, /newest) each recorded 0 JS-originated network
 * calls, across dwelling, scrolling, and every clickable element the sweep
 * could reach. Source-scanning the site's one script (`hn.js`, read in
 * full) confirmed why: its `fetch`/`XMLHttpRequest` calls are gated behind
 * DOM classes (`clicky`) and DOM ids (`#logout`) that only render for a
 * logged-in session, and this run had no Hacker News account to log in
 * with. Those routes are named below as a Gap=Y future extension, not
 * built.
 *
 * The two real transports covering everything this run *could* reach are:
 *
 * 1. HTML-over-the-wire, page-number pagination (`?p=N`) — front page
 *    (`/news`), `/best`, `/show`, `/ask`, `/active`.
 * 2. HTML-over-the-wire, cursor pagination (`?next=<id>&n=<rank>`) —
 *    `/newest`, and per-user `/submitted`, `/threads` (bare `?next=<id>`,
 *    no `n`). Confirmed by fetching page 1 and the `next=` cursor from its
 *    own "More" link and diffing item ids — `?p=2` on `/newest` silently
 *    returns page 1 again rather than erroring, which is worth knowing
 *    before trusting a page-number cache key.
 *
 * Both are the same transport class (`HTML-over-the-wire`, per the
 * reference domain's Route 27/28 convention) with two different pagination
 * encodings, so routes below accept whichever cursor shape the upstream
 * page actually renders rather than assuming one.
 *
 * ACCESS GAP: none. `curl` with a default or absent User-Agent, no cookies,
 * reaches the same 200 response the browser does for every route below —
 * confirmed directly, not assumed. All routes use `rateLimitedFetch`
 * (`browserRequired: false`).
 *
 * NOT BUILT (fired in a browser, carries no data): `hn.js`, `news.css`,
 * `y18.svg`, `triangle.svg`, `s.gif`. Every page load requests all five and
 * a recall check lists them as endpoints with no route, which they are and
 * should stay: four are chrome and the fifth is the site's only script.
 * `hn.js` is read as *source* — it is where the session-gated XHR calls
 * below were found — and proxying it as data would return JavaScript to a
 * caller asking for stories.
 *
 * NOT BUILT (present in source, session-gated, no credentials to verify):
 *  - `vote?id=&how=&auth=&goto=&js=t`         — fire-and-forget XHR GET,
 *    only reachable for a logged-in session (anonymous vote links carry no
 *    `clicky` class and no `auth` token; clicking one full-navigates to a
 *    login form instead).
 *  - `collapse?id=`                            — same fire-and-forget XHR
 *    GET, gated behind `document.getElementById('logout')`.
 *  - `snip-story?id=&onop=&next=`              — genuine
 *    `fetch(url).then(r => r.json())` used by `/newest` to splice in the
 *    next story after a logged-in user hides one; the `hide` link that
 *    drives it is absent from the DOM entirely for anonymous sessions.
 *  - `POST /vote` (`id,how,goto,acct,pw`), `POST /comment`, `POST /login`,
 *    `POST /submit` — real `<form method="post">`s found via DOM
 *    inspection (Form-encoded POST, present) that all require credentials.
 *
 * SEARCH — supersedes the earlier run's "out of scope" note on this same
 * form, which is retired rather than left standing. That run recorded the
 * search box as a real part of the front end that it did not follow, on the
 * grounds that following it would be discovering hn.algolia.com. A later
 * run followed it: the interaction sweep pressed Enter in the box, the page
 * full-navigated, and the SPA on the other side issued a POST to an Algolia
 * index. That call is the only JSON API this site's front end reaches
 * without a login, it was found by interception rather than by reading
 * anybody's API docs, and the entry point is a control HN itself renders.
 * Route 7 consumes it, with its credentials harvested at runtime — see
 * algolia.ts for why the harvest leaves the browser. The boundary the
 * earlier note drew is still true and now stated where it belongs: the
 * transport is hn.algolia.com's, not news.ycombinator.com's, and Route 7 is
 * the only route here that leaves the site.
 *
 * @module domain-hackernews/routes
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import {
	DEBUG,
	DERIVED_STREAM_LIMITS,
	derivedItemStream,
	rateLimitedFetch,
	UpstreamStatusError,
	withCompleteness,
} from '@interceptor/shared';
import { load } from 'cheerio';
import { clearAlgoliaCredentials, getAlgoliaCredentials } from './algolia';
import {
	buildCommentTree,
	extractCursorNext,
	extractPageNext,
	parseCommentRowsFlat,
	parseStoryRows,
} from './parse';

const BASE_URL = process.env.HACKERNEWS_URL ?? 'https://news.ycombinator.com';

/** List types that paginate via `?p=N`, mapped to their upstream path. */
const PAGE_PARAM_LISTS: Record<string, string> = {
	top: 'news',
	best: 'best',
	show: 'show',
	ask: 'ask',
	active: 'active',
};

/** List types that paginate via `?next=<id>&n=<rank>`, mapped to their upstream path. */
const CURSOR_PARAM_LISTS: Record<string, string> = {
	new: 'newest',
};

async function fetchHtml(
	url: string,
): Promise<{ ok: true; html: string } | { ok: false; status: number }> {
	const res = await rateLimitedFetch(url);
	if (!res.ok) return { ok: false, status: res.status };
	return { ok: true, html: await res.text() };
}

export const routes: DomainRoute[] = [
	// ═══════════════════════════════════════════════════════════════════
	// STORY LISTINGS — HTML-over-the-wire, two pagination encodings
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 1: front page / best / show / ask / active — ?p=N ────
	// ─── and new (/newest) — ?next=<id>&n=<rank> ─────────────────────
	{
		method: 'GET',
		path: '/list/:type',
		examples: ['/list/top', '/list/top?page=2', '/list/new', '/list/best'],
		upstream: [
			// The bare origin is the same document `/news` serves and is what a
			// browser actually requests when somebody types the site in. Named
			// here so the coverage check can match it: the route reaches it under
			// its other path, and an unnamed endpoint reads as an unexplained gap.
			'news.ycombinator.com/',
			'news.ycombinator.com/news?p={page}',
			'news.ycombinator.com/best?p={page}',
			'news.ycombinator.com/show?p={page}',
			'news.ycombinator.com/ask?p={page}',
			'news.ycombinator.com/active?p={page}',
			'news.ycombinator.com/newest?next={id}&n={rank}',
		],
		transport: 'HTML-over-the-wire',
		description:
			"Story listing (front page, best, show, ask, active, newest). Page-number lists take ?page=N; newest takes ?next=<id>&n=<rank> from the previous response's nextCursor.",
		browserRequired: false,
		handler: async (c) => {
			const type = c.req.param('type') ?? '';
			const q = new URL(c.req.url).searchParams;

			let upstreamUrl: string;
			let paginationMode: 'page' | 'cursor';
			if (type in PAGE_PARAM_LISTS) {
				paginationMode = 'page';
				const page = q.get('page') ?? '1';
				upstreamUrl = `${BASE_URL}/${PAGE_PARAM_LISTS[type]}?p=${encodeURIComponent(page)}`;
			} else if (type in CURSOR_PARAM_LISTS) {
				paginationMode = 'cursor';
				const next = q.get('next');
				const n = q.get('n');
				const path = CURSOR_PARAM_LISTS[type];
				upstreamUrl = next
					? `${BASE_URL}/${path}?next=${encodeURIComponent(next)}${n ? `&n=${encodeURIComponent(n)}` : ''}`
					: `${BASE_URL}/${path}`;
			} else {
				return c.json(
					{
						error: `Unknown list type '${type}'. Use one of: ${[...Object.keys(PAGE_PARAM_LISTS), ...Object.keys(CURSOR_PARAM_LISTS)].join(', ')}`,
					},
					400,
				);
			}

			DEBUG('hackernews', `list/${type}: fetching ${upstreamUrl}`);
			const res = await fetchHtml(upstreamUrl);
			if (!res.ok) return c.json({ error: `List page returned ${res.status}` }, 502);

			const $ = load(res.html);
			const items = parseStoryRows($);
			const nextCursor = paginationMode === 'cursor' ? extractCursorNext($) : null;
			const nextPage = paginationMode === 'page' ? extractPageNext($) : null;

			return c.json(
				withCompleteness({
					type,
					paginationMode,
					items,
					returned: items.length,
					hasMore: paginationMode === 'cursor' ? nextCursor !== null : nextPage !== null,
					nextCursor,
					nextPage,
				}),
			);
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// ITEM DETAIL — story + full nested comment tree
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 2: item?id=X — story plus every comment, nested ──────
	// Confirmed the site renders the ENTIRE thread server-side regardless of
	// size (verified against a 1,713-comment thread: 1,714 vote-arrow ids,
	// zero pagination link) — there is no comment pagination to chase.
	{
		method: 'GET',
		path: '/item/:id',
		examples: ['/item/49089755'],
		upstream: ['news.ycombinator.com/item?id={id}'],
		transport: 'HTML-over-the-wire',
		description: 'Story detail with its full comment tree, nested to match on-page indentation.',
		browserRequired: false,
		handler: async (c) => {
			const id = c.req.param('id') ?? '';
			const upstreamUrl = `${BASE_URL}/item?id=${encodeURIComponent(id)}`;

			DEBUG('hackernews', `item/${id}: fetching ${upstreamUrl}`);
			const res = await fetchHtml(upstreamUrl);
			if (!res.ok) return c.json({ error: `Item page returned ${res.status}` }, 502);

			const $ = load(res.html);
			const story = parseStoryRows($)[0] ?? null;
			if (!story) return c.json({ error: 'Item not found' }, 404);

			const flatComments = parseCommentRowsFlat($);
			const comments = buildCommentTree(flatComments);

			return c.json({
				story,
				comments,
				returnedCommentCount: flatComments.length,
				indicatedCommentCount: story.commentCount,
				hasMore: story.commentCount !== null && flatComments.length < story.commentCount,
			});
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// USER PROFILE
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 3: user?id=X — profile (karma, created, about) ───────
	{
		method: 'GET',
		path: '/user/:id',
		examples: ['/user/pg'],
		upstream: ['news.ycombinator.com/user?id={id}'],
		transport: 'HTML-over-the-wire',
		description: "User profile: karma, account age, 'about' text.",
		browserRequired: false,
		handler: async (c) => {
			const id = c.req.param('id') ?? '';
			const upstreamUrl = `${BASE_URL}/user?id=${encodeURIComponent(id)}`;

			DEBUG('hackernews', `user/${id}: fetching ${upstreamUrl}`);
			const res = await fetchHtml(upstreamUrl);
			if (!res.ok) return c.json({ error: `User page returned ${res.status}` }, 502);

			const $ = load(res.html);
			const rows = $('#bigbox tr');
			if (rows.length === 0) return c.json({ error: 'User not found' }, 404);

			const fields: Record<string, string> = {};
			rows.each((_, el) => {
				const cells = $(el).find('td');
				const label = cells.first().text().trim().replace(/:$/, '');
				if (!label) return;
				fields[label] = cells.eq(1).text().trim();
			});

			return c.json({
				id,
				karma: fields.karma ? Number(fields.karma) : null,
				created: fields.created ?? null,
				about: fields.about ?? null,
			});
		},
	},

	// ─── Route 4: submitted?id=X — a user's submitted stories ───────
	// Same row shape and cursor pagination as /list/new; a separate route
	// because it is a different data type (one user's stories, not a
	// site-wide ranking) even though it shares the story-row parser.
	{
		method: 'GET',
		path: '/user/:id/submitted',
		examples: ['/user/dang/submitted'],
		upstream: ['news.ycombinator.com/submitted?id={id}&next={id}&n={rank}'],
		transport: 'HTML-over-the-wire',
		description: "A user's submitted stories, cursor-paginated.",
		browserRequired: false,
		handler: async (c) => {
			const id = c.req.param('id') ?? '';
			const q = new URL(c.req.url).searchParams;
			const next = q.get('next');
			const n = q.get('n');
			const upstreamUrl = next
				? `${BASE_URL}/submitted?id=${encodeURIComponent(id)}&next=${encodeURIComponent(next)}${n ? `&n=${encodeURIComponent(n)}` : ''}`
				: `${BASE_URL}/submitted?id=${encodeURIComponent(id)}`;

			DEBUG('hackernews', `user/${id}/submitted: fetching ${upstreamUrl}`);
			const res = await fetchHtml(upstreamUrl);
			if (!res.ok) return c.json({ error: `Submitted page returned ${res.status}` }, 502);

			const $ = load(res.html);
			const items = parseStoryRows($);
			const nextCursor = extractCursorNext($);

			return c.json({
				id,
				items,
				returned: items.length,
				hasMore: nextCursor !== null,
				nextCursor,
			});
		},
	},

	// ─── Route 5: threads?id=X — a user's comments, cursor-paginated ─
	{
		method: 'GET',
		path: '/user/:id/comments',
		examples: ['/user/dang/comments'],
		upstream: ['news.ycombinator.com/threads?id={id}&next={id}'],
		transport: 'HTML-over-the-wire',
		description:
			"A user's comment history, flat (not nested — each comment sits on a different story), cursor-paginated.",
		browserRequired: false,
		handler: async (c) => {
			const id = c.req.param('id') ?? '';
			const q = new URL(c.req.url).searchParams;
			const next = q.get('next');
			const upstreamUrl = next
				? `${BASE_URL}/threads?id=${encodeURIComponent(id)}&next=${encodeURIComponent(next)}`
				: `${BASE_URL}/threads?id=${encodeURIComponent(id)}`;

			DEBUG('hackernews', `user/${id}/comments: fetching ${upstreamUrl}`);
			const res = await fetchHtml(upstreamUrl);
			if (!res.ok) return c.json({ error: `Threads page returned ${res.status}` }, 502);

			const $ = load(res.html);
			const items = parseCommentRowsFlat($);
			const nextCursor = extractCursorNext($);

			return c.json({
				id,
				items,
				returned: items.length,
				hasMore: nextCursor !== null,
				nextCursor,
			});
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// RSS / XML FEED
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 6: /rss — top-stories XML feed ────────────────────────
	// Discoverable from <link rel="alternate" type="application/rss+xml">
	// in every page's <head>. No pagination: ?p=2 returns the same 30
	// items as ?p=1 (confirmed by diffing story ids) — the feed is a fixed
	// front-page snapshot, not a paged collection.
	{
		method: 'GET',
		path: '/rss',
		examples: ['/rss'],
		upstream: ['news.ycombinator.com/rss'],
		transport: 'HTML-over-the-wire',
		description: 'Top-stories RSS feed: parsed XML, no pagination support upstream.',
		browserRequired: false,
		handler: async (c) => {
			const res = await fetchHtml(`${BASE_URL}/rss`);
			if (!res.ok) return c.json({ error: `RSS returned ${res.status}` }, 502);

			const $ = load(res.html, { xml: true });
			const items = $('item')
				.map((_, el) => ({
					title: $(el).find('title').text(),
					link: $(el).find('link').text(),
					commentsUrl: $(el).find('comments').text(),
					pubDate: $(el).find('pubDate').text(),
				}))
				.get();

			return c.json({ title: $('channel > title').text(), items, count: items.length });
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// DATE-ADDRESSED LISTING — a third pagination encoding
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 7: /front — the front page as it stood on a given day ──
	// The same story rows as Route 1, addressed by date rather than by rank:
	// `front?day=YYYY-MM-DD`, and then `&p=N` within that day. Two axes, so
	// the route carries both.
	//
	// The day anchors are returned verbatim rather than interpreted. Their
	// labels are relative ("1 day ago", "1 month ago"), the set differs
	// between today's page and an archived one, and inventing prev/next
	// semantics for them would be describing the page rather than reading
	// it. Returning them is also what caught this route's own first version
	// being wrong: it declared `hasMore: false` on the belief that a day was
	// a fixed 30 items, and the anchor list came back carrying a
	// `?day=…&p=2` More link that disproved it.
	{
		method: 'GET',
		path: '/front',
		// `?page=2` on an archived day is deliberately not an example. It is a
		// real parameter — the page renders its own `front?day=…&p=2` More link —
		// but requesting it during discovery drew a 429 after that session had
		// already spent ~25 requests on the host. That was our footprint rather
		// than the site's policy, and it was not retried; an example that
		// re-provokes it would fail the route for a reason that has nothing to do
		// with the route.
		examples: ['/front', '/front?day=2026-07-27'],
		upstream: ['news.ycombinator.com/front?day={day}&p={page}'],
		transport: 'HTML-over-the-wire',
		description:
			'The front page as it stood on a given day. Date-addressed (?day=YYYY-MM-DD) and page-numbered within the day (?page=N).',
		browserRequired: false,
		handler: async (c) => {
			const q = new URL(c.req.url).searchParams;
			const day = q.get('day');
			if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
				return c.json({ error: `day must be YYYY-MM-DD, got '${day}'` }, 400);
			}
			const page = q.get('page');
			if (page && !/^\d+$/.test(page)) {
				return c.json({ error: `page must be a positive integer, got '${page}'` }, 400);
			}
			const params = new URLSearchParams();
			if (day) params.set('day', day);
			if (page) params.set('p', page);
			const query = params.toString();
			const upstreamUrl = query ? `${BASE_URL}/front?${query}` : `${BASE_URL}/front`;

			DEBUG('hackernews', `front: fetching ${upstreamUrl}`);
			const res = await fetchHtml(upstreamUrl);
			if (!res.ok) return c.json({ error: `Front page returned ${res.status}` }, 502);

			const $ = load(res.html);
			const items = parseStoryRows($);
			const nextPage = extractPageNext($);
			// Only the bare dates: the same selector also matches this page's own
			// More link, which is the next page of this day rather than another
			// day, and Route 1's `nextPage` already carries that.
			const dayLinks = [
				...new Set(
					$('a[href^="front?day="]')
						.map((_, el) => $(el).attr('href')?.slice('front?day='.length) ?? '')
						.get()
						.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
				),
			];

			return c.json(
				withCompleteness({
					day: day ?? null,
					page: page ? Number(page) : 1,
					items,
					returned: items.length,
					hasMore: nextPage !== null,
					nextPage,
					dayLinks,
				}),
			);
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// SEARCH — JSON API, on the origin HN's own search box submits to
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 8: hn.algolia.com's Algolia index ─────────────────────
	// The one JSON transport the anonymous front end reaches, and the only
	// route here that leaves news.ycombinator.com. See the SEARCH note in
	// the module docblock for how it was found and where the boundary sits.
	//
	// The request body is the SPA's own, replayed: `query` and `page` are
	// substituted and everything else is left exactly as observed. The
	// tuning fields (typo tolerance, proximity, searchable attributes) are
	// what make the results match what a visitor sees, and dropping the ones
	// that "look unnecessary" quietly returns a different ranking.
	//
	// `application/x-www-form-urlencoded` on a JSON body is not a mistake —
	// it is how the Algolia browser client dodges a CORS preflight, and it
	// is what was captured on the wire.
	{
		method: 'GET',
		path: '/search',
		examples: ['/search?q=hacker%20news', '/search?q=rust&page=1'],
		upstream: ['hn.algolia.com/', '{appid}-dsn.algolia.net/1/indexes/Item_dev/query'],
		transport: 'JSON API (XHR)',
		description:
			"Story search over the Algolia index HN's search box submits to. Zero-based ?page, 30 hits per page.",
		browserRequired: false,
		handler: async (c) => {
			const q = new URL(c.req.url).searchParams;
			const query = q.get('q');
			if (!query) return c.json({ error: 'q is required' }, 400);
			const page = Number(q.get('page') ?? '0');
			if (!Number.isInteger(page) || page < 0) {
				return c.json(
					{ error: `page must be a non-negative integer, got '${q.get('page')}'` },
					400,
				);
			}

			const creds = await getAlgoliaCredentials();
			const url =
				`https://${creds.host}/1/indexes/Item_dev/query` +
				`?x-algolia-agent=${encodeURIComponent('Algolia for JavaScript (4.13.1); Browser (lite)')}` +
				`&x-algolia-api-key=${creds.apiKey}` +
				`&x-algolia-application-id=${creds.appId}`;

			DEBUG('hackernews', `search: ${query} page=${page}`);
			const res = await rateLimitedFetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: JSON.stringify({
					query,
					analyticsTags: ['web'],
					page,
					hitsPerPage: 30,
					minWordSizefor1Typo: 4,
					minWordSizefor2Typos: 8,
					advancedSyntax: true,
					ignorePlurals: false,
					clickAnalytics: false,
					minProximity: 7,
					numericFilters: [],
					tagFilters: [['story'], []],
					typoTolerance: true,
					queryType: 'prefixNone',
					restrictSearchableAttributes: ['title', 'comment_text', 'url', 'story_text', 'author'],
					getRankingInfo: false,
				}),
			});
			if (!res.ok) {
				// A rotated key answers 403 here and nowhere else, so the cache is
				// dropped on the way out and the next call re-harvests.
				if (res.status === 403) clearAlgoliaCredentials();
				return c.json({ error: `Algolia returned ${res.status}` }, 502);
			}

			const body = (await res.json()) as {
				hits?: unknown[];
				nbHits?: number;
				nbPages?: number;
				page?: number;
				hitsPerPage?: number;
			};
			const hits = body.hits ?? [];

			return c.json({
				query,
				page: body.page ?? page,
				items: hits,
				returned: hits.length,
				total: body.nbHits ?? null,
				totalPages: body.nbPages ?? null,
				hasMore: body.nbPages !== undefined && (body.page ?? page) + 1 < body.nbPages,
			});
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// DERIVED STREAM — liveness this site does not publish
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 9: /stream/new — arrivals on /newest, as SSE ──────────
	//
	// READ THIS BEFORE CITING THE ROUTE: Hacker News has no realtime
	// transport. The elimination table for news.ycombinator.com records
	// SSE ✗ and WebSocket ✗, and this route is not evidence against either
	// row. Nothing is intercepted here. The site answers one whole page per
	// request, exactly as it always has; the stream is manufactured on this
	// side by asking for that page on a timer and reporting what changed.
	// A future reader looking for "which sites stream" must not count this
	// one, and a route that consumes a real upstream stream (see
	// yahoofinance's /stream/subscribe) is a different thing entirely.
	//
	// The mechanism lives in @interceptor/shared — the poll loop, the
	// diff-by-identity, the heartbeat, the disconnect handling and the
	// bounds are what any site would need. All this domain supplies is how
	// to fetch one page and what an item's identity is.
	//
	// Identity is the story id from `tr.athing[id]`, never the rank: the
	// front page and /newest reorder between polls, so a positional key
	// would report a shuffle as a flood of arrivals and miss the real one.
	{
		method: 'GET',
		path: '/stream/new',
		examples: ['/stream/new?seconds=20&interval=6'],
		upstream: ['news.ycombinator.com/newest'],
		transport: 'SSE',
		description:
			'Server-sent events for stories arriving on /newest. DERIVED, not intercepted: HN publishes no stream — this polls the page and diffs by story id.',
		browserRequired: false,
		handler: async (c) => {
			const q = new URL(c.req.url).searchParams;
			const seconds = Number(q.get('seconds') ?? '30');
			const interval = Number(q.get('interval') ?? '10');
			const lifetimeMs = Number.isFinite(seconds) ? seconds * 1000 : undefined;
			const intervalMs = Number.isFinite(interval) ? interval * 1000 : undefined;

			const body = derivedItemStream({
				label: 'hackernews',
				upstream: `${BASE_URL}/newest`,
				lifetimeMs,
				intervalMs,
				// Well under the lifetime, so a caller sees a pulse even in a short
				// window where nothing arrives.
				heartbeatMs: Math.max(5_000, Math.min(DERIVED_STREAM_LIMITS.defaultHeartbeatMs, 8_000)),
				signal: c.req.raw.signal,
				poll: async () => {
					const res = await rateLimitedFetch(`${BASE_URL}/newest`);
					// The status is carried out rather than flattened into a message,
					// because the stream treats 429 differently from every other
					// failure and cannot tell them apart from prose.
					if (!res.ok) throw new UpstreamStatusError(res.status);
					return parseStoryRows(load(await res.text()));
				},
				identify: (story) => story.id,
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
];
