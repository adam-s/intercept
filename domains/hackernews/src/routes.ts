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
 * OUT OF SCOPE: the page's own search box is
 * `<form method="get" action="//hn.algolia.com/">` — a real, observed part
 * of the front end, but it full-navigates to a different site (a distinct
 * origin with its own React SPA, own pagination, and undiscovered API of
 * its own). Wrapping it would be discovering hn.algolia.com, not
 * news.ycombinator.com; it is named here rather than silently dropped.
 *
 * @module domain-hackernews/routes
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import { DEBUG, rateLimitedFetch, withCompleteness } from '@interceptor/shared';
import { load } from 'cheerio';
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
];
