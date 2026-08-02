/**
 * Reddit API Routes
 *
 * ## What the site actually serves, and over what
 *
 * Reddit's current front end ("shreddit") is web components over HTML
 * fragments, not a JSON SPA. The elimination table for this domain records
 * six data-bearing transports; the routes below consume all six.
 *
 * Reddit serves the *same records* four ways, which is the interesting part
 * and the reason each route says which path it took:
 *
 * | Path | Gated? | Shape | Used by |
 * |---|---|---|---|
 * | `/svc/shreddit/**` partials | **no** — direct HTTP 200, no cookie | HTML fragments of `<shreddit-post>` | routes 1-3 |
 * | `<page>.json` gateway | **yes** — direct HTTP 403 for every UA tried | full JSON records | routes 4, 6, 7 |
 * | `/svc/shreddit/graphql` | no, but operation-whitelisted | JSON | route 8 |
 * | `old.reddit.com` HTML | no — direct HTTP 200 | server-rendered HTML | not used; recorded as the fallback |
 *
 * Two measurements decide which one each route takes, both from the
 * access-gap probe in this domain's discovery run:
 *
 *   - A **full document** (`/r/aww/`, a post permalink) fetched over direct
 *     HTTP returns 200 with an 8.4 KB JS-challenge interstitial and zero
 *     posts. Documents are challenge-gated.
 *   - The **partial endpoints under `/svc/shreddit/`** return the real thing
 *     to a bare `fetch` with no cookies at all — 851 KB and 75
 *     `<shreddit-post>` elements for a subreddit feed. They are the cheapest,
 *     least-gated path to a listing on this site, so the feed routes take
 *     them and set `browserRequired: false`.
 *   - The `.json` gateway is the opposite: rich, but 403 to direct HTTP under
 *     a Chrome UA, a Firefox UA, and a custom UA alike (so it is Reddit's
 *     policy, not a rate limit we caused). Through the connected browser it
 *     is 200. Those routes keep `browserRequired` at its default.
 *
 * ## Values the routes need
 *
 * `csrf_token` is a first-party cookie the connected browser already holds;
 * routes that need it read it with `browser.evaluate(() => document.cookie)`.
 * The realtime bearer is *computed*, not harvestable: it comes from
 * `POST /svc/shreddit/token` with that csrf, and expires in 24 h — route 9
 * mints a fresh one per call rather than caching one that will go stale.
 *
 * ## Endpoints the browser calls that deliberately have no route
 *
 * Coverage reports these as unaccounted; each is accounted for here rather
 * than left unexplained. None of them carries a record a consumer would ask
 * for, and three of them are write-only.
 *
 *   - `/svc/shreddit/events`, `/svc/events/preload-head`,
 *     `/svc/shreddit/perfMetrics` — telemetry sinks. They accept event
 *     batches and answer `OK`/`Created`; there is nothing to read back.
 *   - `/svc/shreddit/styling-overrides/`, `/svc/shreddit/tailwind-css` —
 *     per-subreddit and global CSS. Presentation, not records.
 *   - `preview.redd.it/*`, `external-preview.redd.it/*`,
 *     `styles.redditmedia.com/*` — thumbnail images. Their URLs already ride
 *     on the post records routes 4, 6 and 7 return.
 *
 * ## Constants that can rotate without notice
 *
 * `SHREDDIT_GQL_OPERATION` (route 8) is a server-side operation *name*, not a
 * query document — the gateway 500s on any name it does not know. Reddit can
 * retire one at any deploy, and the failure will look like a server error
 * rather than a logic bug.
 *
 * @module domain-reddit/routes
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import { DEBUG, withCompleteness } from '@interceptor/shared';
import { load } from 'cheerio';

const BASE_URL = 'https://www.reddit.com';

/** The partial endpoints render fragments for this Accept header — see config.ts. */
const PARTIAL_HEADERS = { Accept: 'text/vnd.reddit.partial+html, text/html;q=0.9' };

/**
 * Direct-HTTP identity for the ungated partial endpoints.
 *
 * A runtime `fetch` sends no UA at all by default, and Reddit answers an
 * absent UA differently from a browser's. This is the one thing the partials
 * want; they need no cookie, no csrf, and no session — which is exactly why
 * these routes are allowed off the browser rung at all.
 */
const DIRECT_HEADERS = {
	...PARTIAL_HEADERS,
	'User-Agent':
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

/** The one shreddit GraphQL operation reachable logged-out that returns records. */
const SHREDDIT_GQL_OPERATION = 'SubredditByName';

/** Reddit's realtime gateway, named in the shreddit bundle's graphql-ws client. */
const REALTIME_WS_URL = 'wss://gql-realtime.reddit.com/query';

function num(v: string | undefined): number | null {
	if (v === undefined) return null;
	const n = Number(v);
	return Number.isNaN(n) ? null : n;
}

interface RedditPost {
	id: string;
	title: string | null;
	permalink: string | null;
	author: string | null;
	subreddit: string | null;
	score: number | null;
	commentCount: number | null;
	createdAt: string | null;
	domain: string | null;
	postType: string | null;
	contentHref: string | null;
	nsfw: boolean;
}

/**
 * Parse `<shreddit-post>` cards out of a partial.
 *
 * This is the "data in HTML attributes" case: the fields a JSON API would put
 * in a body are attributes on a custom element, so cheerio does the work
 * `JSON.parse` would normally do. Nothing here is a JSON blob — a scan for
 * one on these documents comes back empty and reads like "no data".
 */
function parsePostsHtml(html: string): { posts: RedditPost[]; nextUrl: string | null } {
	const $ = load(html);
	const seen = new Set<string>();
	const posts: RedditPost[] = [];
	$('shreddit-post').each((_, el) => {
		const $el = $(el);
		const id = $el.attr('id');
		if (!id || seen.has(id)) return;
		seen.add(id);
		posts.push({
			id,
			title: $el.attr('post-title') ?? null,
			permalink: $el.attr('permalink') ?? null,
			author: $el.attr('author') ?? null,
			subreddit: $el.attr('subreddit-prefixed-name') ?? null,
			score: num($el.attr('score')),
			commentCount: num($el.attr('comment-count')),
			createdAt: $el.attr('created-timestamp') ?? null,
			domain: $el.attr('domain') ?? null,
			postType: $el.attr('post-type') ?? null,
			contentHref: $el.attr('content-href') ?? null,
			nsfw: $el.attr('nsfw') !== undefined,
		});
	});
	// The next-page cursor rides in a <faceplate-partial slot="load-after" src="...">
	// that the front end swaps in when it scrolls into view. We read the URL it
	// would have fetched rather than driving the scroll.
	const nextSrc = $('faceplate-partial[slot="load-after"]').attr('src') ?? null;
	const nextUrl = nextSrc ? new URL(nextSrc, BASE_URL).toString() : null;
	return { posts, nextUrl };
}

/** Round-trippable continuation params, lifted off the load-after partial. */
function nextCursorOf(nextUrl: string | null): { after: string; cursor: string } | null {
	if (!nextUrl) return null;
	const p = new URL(nextUrl).searchParams;
	const after = p.get('after');
	if (!after) return null;
	return { after, cursor: p.get('cursor') ?? after };
}

interface RedditComment {
	id: string | null;
	author: string | null;
	score: number | null;
	depth: number | null;
	permalink: string | null;
	createdAt: string | null;
	body: string;
}

interface MoreComments {
	url: string;
	cursor: string | null;
}

/**
 * Parse `<shreddit-comment>` elements out of a rendered post page or a
 * `more-comments` partial. Comment text lives in a nested
 * `#{thingId}-post-rtjson-content` div rather than an attribute — that div is
 * where the front end's rich-text renderer writes its output.
 */
function parseCommentsHtml(html: string): { comments: RedditComment[]; more: MoreComments | null } {
	const $ = load(html);
	const comments: RedditComment[] = [];
	$('shreddit-comment').each((_, el) => {
		const $el = $(el);
		const bodyEl = $el.find('[id$="-post-rtjson-content"]').first();
		comments.push({
			id: $el.attr('thingid') ?? null,
			author: $el.attr('author') ?? null,
			score: num($el.attr('score')),
			depth: num($el.attr('depth')),
			permalink: $el.attr('permalink') ?? null,
			createdAt: $el.attr('created') ?? null,
			body: bodyEl.text().trim(),
		});
	});

	// <faceplate-partial id="top-level-more-comments-partial"
	//   src="/svc/shreddit/more-comments/..." method="post">
	//   <input type="hidden" name="cursor" value="...">
	const moreEl = $('#top-level-more-comments-partial');
	const moreSrc = moreEl.attr('src');
	const cursor = moreEl.find('input[name="cursor"]').attr('value') ?? null;
	const more = moreSrc ? { url: new URL(moreSrc, BASE_URL).toString(), cursor } : null;

	return { comments, more };
}

/** A `.json` gateway listing child, flattened to the fields a consumer asks for. */
interface JsonListingChild {
	id: string;
	kind: string;
	title: string | null;
	author: string | null;
	subreddit: string | null;
	score: number | null;
	numComments: number | null;
	createdUtc: number | null;
	permalink: string | null;
	url: string | null;
	isVideo: boolean;
	hlsUrl: string | null;
	selftext: string | null;
}

interface RawListing {
	kind?: string;
	data?: {
		after?: string | null;
		dist?: number | null;
		children?: { kind: string; data: Record<string, unknown> }[];
	};
}

function flattenListing(listing: RawListing): {
	items: JsonListingChild[];
	after: string | null;
	dist: number | null;
} {
	const children = listing?.data?.children ?? [];
	const items = children.map((c) => {
		const d = c.data as Record<string, unknown>;
		const media = d.media as { reddit_video?: { hls_url?: string } } | null | undefined;
		return {
			id: String(d.id ?? ''),
			kind: c.kind,
			title: (d.title as string) ?? null,
			author: (d.author as string) ?? null,
			subreddit: (d.subreddit as string) ?? null,
			score: typeof d.score === 'number' ? d.score : null,
			numComments: typeof d.num_comments === 'number' ? d.num_comments : null,
			createdUtc: typeof d.created_utc === 'number' ? d.created_utc : null,
			permalink: (d.permalink as string) ?? null,
			url: (d.url as string) ?? null,
			isVideo: d.is_video === true,
			// Reddit HTML-escapes the ampersands inside these signed URLs.
			hlsUrl: media?.reddit_video?.hls_url?.replace(/&amp;/g, '&') ?? null,
			selftext: typeof d.selftext === 'string' ? d.selftext.slice(0, 2000) : null,
		};
	});
	return { items, after: listing?.data?.after ?? null, dist: listing?.data?.dist ?? null };
}

/** One comment out of the `.json` comment tree, kept flat with a depth marker. */
interface JsonComment {
	id: string;
	author: string | null;
	score: number | null;
	depth: number;
	createdUtc: number | null;
	body: string | null;
	moreChildrenCount: number | null;
}

/**
 * Walk the `.json` comment tree depth-first.
 *
 * `kind: "more"` nodes are the tree's own truncation marker — they carry a
 * count of hidden replies and no bodies. They are surfaced rather than
 * dropped, because a consumer that never sees one cannot tell a complete
 * thread from a clipped one.
 */
function flattenComments(node: RawListing, depth = 0, out: JsonComment[] = []): JsonComment[] {
	for (const child of node?.data?.children ?? []) {
		const d = child.data as Record<string, unknown>;
		if (child.kind === 'more') {
			out.push({
				id: String(d.id ?? 'more'),
				author: null,
				score: null,
				depth,
				createdUtc: null,
				body: null,
				moreChildrenCount: typeof d.count === 'number' ? d.count : null,
			});
			continue;
		}
		out.push({
			id: String(d.id ?? ''),
			author: (d.author as string) ?? null,
			score: typeof d.score === 'number' ? d.score : null,
			depth,
			createdUtc: typeof d.created_utc === 'number' ? d.created_utc : null,
			body: typeof d.body === 'string' ? d.body : null,
			moreChildrenCount: null,
		});
		const replies = d.replies;
		if (replies && typeof replies === 'object') {
			flattenComments(replies as RawListing, depth + 1, out);
		}
	}
	return out;
}

/** Master-playlist variant, parsed off `#EXT-X-STREAM-INF` lines. */
interface HlsVariant {
	uri: string;
	bandwidth: number | null;
	resolution: string | null;
	codecs: string | null;
}

function parseHlsMaster(m3u8: string): HlsVariant[] {
	const lines = m3u8.split('\n').map((l) => l.trim());
	const variants: HlsVariant[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
		const uri = lines[i + 1];
		if (!uri || uri.startsWith('#')) continue;
		const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
		const bandwidth = attrs.match(/BANDWIDTH=(\d+)/)?.[1];
		const resolution = attrs.match(/RESOLUTION=([\d x]+)/)?.[1];
		const codecs = attrs.match(/CODECS="([^"]+)"/)?.[1];
		variants.push({
			uri,
			bandwidth: bandwidth ? Number(bandwidth) : null,
			resolution: resolution ?? null,
			codecs: codecs ?? null,
		});
	}
	return variants;
}

/**
 * Fetch a post's comments page as the browser actually renders it.
 *
 * A bare same-origin `fetch()` of a post permalink returns 329 KB containing
 * zero `<shreddit-comment>` elements and no more-comments partial: the
 * comment section is mounted client-side after hydration. So this route needs
 * a real navigation, not a fetch — and only route 5 pays that cost, because
 * only route 5 needs the cursor and csrf pair the rendered DOM carries.
 *
 * The hydration swap replaces part of the DOM, which tears down Playwright's
 * JS execution context mid-flight; an `evaluate()` racing it fails with
 * "Execution context was destroyed" rather than timing out. So this polls with
 * fresh short-lived `evaluate()` calls and treats that specific error as "not
 * settled yet".
 */
async function fetchHydratedPostPage(
	browser: {
		navigate: (url: string) => Promise<void>;
		evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
	},
	url: string,
	{ attempts = 8, intervalMs = 750 }: { attempts?: number; intervalMs?: number } = {},
): Promise<string> {
	await browser.navigate(url);
	for (let i = 0; i < attempts; i++) {
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		try {
			const ready = await browser.evaluate(
				() => document.querySelectorAll('shreddit-comment').length > 0,
			);
			if (ready) break;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes('Execution context was destroyed')) throw err;
		}
	}
	for (let i = 0; i < 3; i++) {
		try {
			return await browser.evaluate(() => document.documentElement.outerHTML);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes('Execution context was destroyed') || i === 2) throw err;
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
	}
	throw new Error('fetchHydratedPostPage: unreachable');
}

/** Read the first-party csrf cookie out of the connected browser's session. */
async function readCsrfToken(browser: {
	evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}): Promise<string | null> {
	const cookieStr = await browser.evaluate(() => document.cookie);
	return (
		cookieStr
			.split('; ')
			.find((kv) => kv.startsWith('csrf_token='))
			?.slice('csrf_token='.length) ?? null
	);
}

/**
 * Fetch a partial endpoint over direct HTTP, off the browser rung.
 *
 * Legitimate here and nowhere else in this file: these endpoints were probed
 * with no cookies, no session, and no browser and answered 200 with the full
 * fragment. Anything that starts failing here belongs back on
 * `browser.browserFetch` — see the access-gap table in the module docblock.
 */
async function fetchPartial(url: string): Promise<{ status: number; html: string }> {
	DEBUG('reddit', `partial (direct): ${url}`);
	const res = await fetch(url, {
		headers: DIRECT_HEADERS,
		signal: AbortSignal.timeout(30_000),
	});
	return { status: res.status, html: await res.text() };
}

export const routes: DomainRoute[] = [
	// ─── Route 1: Subreddit feed — HTML-over-the-wire, direct HTTP ────────
	// The `community-more-posts` partial serves page 1 with no cursor at all,
	// so there is no reason to fetch the challenge-gated SSR document first.
	{
		method: 'GET',
		path: '/r/:subreddit',
		examples: ['/r/AskReddit', '/r/aww?sort=hot'],
		upstream: ['www.reddit.com/svc/shreddit/community-more-posts/{sort}/'],
		transport: 'HTML-over-the-wire',
		browserRequired: false,
		description:
			'Subreddit post feed from the shreddit partial. Pass ?after=&cursor= from a prior response to page.',
		handler: async (c) => {
			const subreddit = (c.req.param() as Record<string, string>).subreddit;
			const url = new URL(c.req.url);
			const after = url.searchParams.get('after') ?? '';
			// `cursor` is usually the same opaque token as `after`, and the site's
			// own load-after partial sometimes omits it. Default rather than
			// requiring a caller to supply a parameter the site does not send.
			const cursor = url.searchParams.get('cursor') ?? after;
			const sort = (url.searchParams.get('sort') ?? 'best').toLowerCase();
			const feedLength = Math.min(Number(url.searchParams.get('feedLength') ?? '25'), 100);

			const target = new URL(
				`${BASE_URL}/svc/shreddit/community-more-posts/${encodeURIComponent(sort)}/`,
			);
			target.searchParams.set('name', subreddit);
			target.searchParams.set('feedLength', String(feedLength));
			target.searchParams.set('t', 'DAY');
			if (after) {
				target.searchParams.set('after', after);
				target.searchParams.set('cursor', cursor);
			}

			const { status, html } = await fetchPartial(target.toString());
			if (status !== 200) return c.json({ error: `Feed partial returned ${status}` }, 502);

			const { posts, nextUrl } = parsePostsHtml(html);
			if (posts.length === 0) {
				return c.json(
					{ error: `No posts in the partial for r/${subreddit} — subreddit missing or private?` },
					502,
				);
			}
			return c.json({
				subreddit,
				sort,
				posts,
				returned: posts.length,
				hasMore: nextUrl !== null,
				nextCursor: nextCursorOf(nextUrl),
			});
		},
	},

	// ─── Route 2: r/popular frontpage — same transport, different family ──
	{
		method: 'GET',
		path: '/popular',
		examples: ['/popular', '/popular?feedLength=10'],
		upstream: ['www.reddit.com/svc/shreddit/feeds/popular-feed'],
		transport: 'HTML-over-the-wire',
		browserRequired: false,
		description:
			'r/popular frontpage feed from the shreddit partial. Pass ?after=&cursor= to page.',
		handler: async (c) => {
			const url = new URL(c.req.url);
			const after = url.searchParams.get('after') ?? '';
			const cursor = url.searchParams.get('cursor') ?? after;
			const sort = (url.searchParams.get('sort') ?? 'BEST').toUpperCase();
			const feedLength = Math.min(Number(url.searchParams.get('feedLength') ?? '25'), 100);

			const target = new URL(`${BASE_URL}/svc/shreddit/feeds/popular-feed`);
			target.searchParams.set('sort', sort);
			target.searchParams.set('feedLength', String(feedLength));
			if (after) {
				target.searchParams.set('after', after);
				target.searchParams.set('cursor', cursor);
			}

			const { status, html } = await fetchPartial(target.toString());
			if (status !== 200) return c.json({ error: `Popular partial returned ${status}` }, 502);

			const { posts, nextUrl } = parsePostsHtml(html);
			if (posts.length === 0) return c.json({ error: 'No posts in the popular partial' }, 502);
			return c.json({
				sort,
				posts,
				returned: posts.length,
				hasMore: nextUrl !== null,
				nextCursor: nextCursorOf(nextUrl),
			});
		},
	},

	// ─── Route 3: User profile feed — the hover/scroll-gated partial ──────
	// This endpoint fires only when a profile's feed reaches its scroll
	// boundary; passive browsing never calls it. It returns both the user's
	// posts and their comments in one fragment.
	{
		method: 'GET',
		path: '/user/:username',
		// Both accounts post to their own profile. An account that only ever
		// comments inside subreddits has an empty *overview* feed — u/AutoModerator
		// is the standing example — and this route reports that as a 502 rather
		// than as an empty success, so such a name is a poor example here.
		examples: ['/user/spez', '/user/Watchful1?feedLength=10'],
		upstream: ['www.reddit.com/svc/shreddit/profiles/profile_overview-more-posts/{sort}/'],
		transport: 'HTML-over-the-wire',
		browserRequired: false,
		description: 'A user profile overview feed (posts + comments) from the shreddit partial.',
		handler: async (c) => {
			const username = (c.req.param() as Record<string, string>).username;
			const url = new URL(c.req.url);
			const after = url.searchParams.get('after') ?? '';
			const sort = (url.searchParams.get('sort') ?? 'new').toLowerCase();
			const feedLength = Math.min(Number(url.searchParams.get('feedLength') ?? '25'), 100);

			const target = new URL(
				`${BASE_URL}/svc/shreddit/profiles/profile_overview-more-posts/${encodeURIComponent(sort)}/`,
			);
			target.searchParams.set('name', username);
			target.searchParams.set('feedLength', String(feedLength));
			if (after) target.searchParams.set('after', after);

			const { status, html } = await fetchPartial(target.toString());
			if (status !== 200) return c.json({ error: `Profile partial returned ${status}` }, 502);

			const { posts, nextUrl } = parsePostsHtml(html);
			const { comments } = parseCommentsHtml(html);
			if (posts.length === 0 && comments.length === 0) {
				return c.json({ error: `No activity in the profile partial for u/${username}` }, 502);
			}
			return c.json({
				username,
				sort,
				posts,
				comments,
				returned: posts.length + comments.length,
				hasMore: nextUrl !== null,
				nextCursor: nextCursorOf(nextUrl),
			});
		},
	},

	// ─── Route 4: Post detail + comment tree — JSON gateway, browser rung ─
	// The `.json` suffix carries the whole thread as records: [listing of one
	// post, listing of comments]. It is 403 to direct HTTP under every UA
	// tried, so this one stays on the browser.
	{
		method: 'GET',
		path: '/post/:subreddit/:id',
		examples: ['/post/aww/1v96p9o', '/post/aww/1v96p9o?limit=20'],
		upstream: ['www.reddit.com/r/{subreddit}/comments/{id}.json'],
		transport: 'JSON API (XHR)',
		description: 'Post detail plus its comment tree, over the .json gateway.',
		handler: async (c, browser) => {
			const params = c.req.param() as Record<string, string>;
			const subreddit = params.subreddit;
			const id = params.id.replace(/^t3_/, '');
			const limit = Math.min(Number(new URL(c.req.url).searchParams.get('limit') ?? '50'), 500);
			const sort = new URL(c.req.url).searchParams.get('sort') ?? 'confidence';

			const target = `${BASE_URL}/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(id)}.json?limit=${limit}&sort=${encodeURIComponent(sort)}`;
			DEBUG('reddit', `post: ${target}`);
			const res = await browser.browserFetch<RawListing[]>(target);
			if (res.status !== 200 || !Array.isArray(res.data)) {
				return c.json({ error: `Post .json returned ${res.status}` }, 502);
			}

			const [postListing, commentListing] = res.data;
			const post = flattenListing(postListing).items[0] ?? null;
			if (!post) return c.json({ error: `No post record for ${subreddit}/${id}` }, 502);
			const comments = flattenComments(commentListing);
			// `num_comments` counts the whole thread; a page of the tree is a
			// fraction of it, and saying so is the point of this field.
			const indicatedTotal = post.numComments;
			const bodied = comments.filter((x) => x.body !== null).length;

			return c.json({
				subreddit,
				post,
				comments,
				returned: bodied,
				indicatedTotal,
				hasMore:
					comments.some((x) => x.moreChildrenCount !== null) ||
					(indicatedTotal !== null && bodied < indicatedTotal),
			});
		},
	},

	// ─── Route 5: Comments continuation — Form-encoded POST ───────────────
	// The front end reads `csrf_token` out of `document.cookie` and echoes it
	// into a form-encoded POST body alongside the cursor from a hidden
	// <input>. Both are session-scoped and go stale, so this re-reads them
	// from a live render rather than trusting caller-supplied ones.
	//
	// This is the one route that pays for a navigation: a bare fetch of a post
	// permalink comes back with zero comments (see fetchHydratedPostPage).
	{
		method: 'POST',
		path: '/post/:subreddit/:id/comments/more',
		examples: ['/post/aww/1v96p9o/comments/more'],
		upstream: [
			'www.reddit.com/r/{subreddit}/comments/{id}/',
			'www.reddit.com/svc/shreddit/more-comments/{subreddit}/{fullname}',
		],
		transport: 'Form-encoded POST',
		description: 'The next page of top-level comments (cursor + csrf_token form POST).',
		handler: async (c, browser) => {
			const params = c.req.param() as Record<string, string>;
			const subreddit = params.subreddit;
			const id = params.id.replace(/^t3_/, '');
			const postUrl = `${BASE_URL}/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(id)}/`;

			DEBUG('reddit', `comments/more: refreshing cursor from ${postUrl}`);
			const html = await fetchHydratedPostPage(browser, postUrl);
			const { more } = parseCommentsHtml(html);
			if (!more || !more.cursor) {
				return c.json({
					subreddit,
					comments: [],
					returned: 0,
					hasMore: false,
					note: 'The rendered page offered no more-comments cursor — the thread ends here.',
				});
			}

			const csrfToken = await readCsrfToken(browser);
			if (!csrfToken) {
				return c.json({ error: 'Could not read csrf_token from the browser session' }, 502);
			}

			const body = `cursor=${encodeURIComponent(more.cursor)}&csrf_token=${encodeURIComponent(csrfToken)}`;
			DEBUG('reddit', `comments/more: posting to ${more.url}`);
			const res = await browser.browserFetch<string>(more.url, {
				method: 'POST',
				headers: { ...PARTIAL_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			});
			if (res.status !== 200 || typeof res.data !== 'string') {
				return c.json({ error: `Comments continuation returned ${res.status}` }, 502);
			}

			const { comments, more: nextMore } = parseCommentsHtml(res.data);
			return c.json({
				subreddit,
				comments,
				returned: comments.length,
				hasMore: nextMore !== null,
				moreCursor: nextMore?.cursor ?? null,
			});
		},
	},

	// ─── Route 6: Subreddit listing over the JSON gateway ─────────────────
	// The same records as route 1, in the richer shape, at the cost of needing
	// the browser. Both exist deliberately: route 1 is the cheap path, this is
	// the one to reach for when a field route 1 cannot see is wanted.
	{
		method: 'GET',
		path: '/json/r/:subreddit',
		examples: ['/json/r/aww?limit=25', '/json/r/AskReddit?sort=new&limit=10'],
		upstream: ['www.reddit.com/r/{subreddit}/{sort}.json'],
		transport: 'JSON API (XHR)',
		description: 'Subreddit listing over the .json gateway. Cursor pagination via ?after=.',
		handler: async (c, browser) => {
			const subreddit = (c.req.param() as Record<string, string>).subreddit;
			const url = new URL(c.req.url);
			const sort = url.searchParams.get('sort') ?? 'hot';
			const limit = Math.min(Number(url.searchParams.get('limit') ?? '25'), 100);
			const after = url.searchParams.get('after');

			const target = new URL(
				`${BASE_URL}/r/${encodeURIComponent(subreddit)}/${encodeURIComponent(sort)}.json`,
			);
			target.searchParams.set('limit', String(limit));
			if (after) target.searchParams.set('after', after);

			DEBUG('reddit', `json listing: ${target}`);
			const res = await browser.browserFetch<RawListing>(target.toString());
			if (res.status !== 200 || typeof res.data !== 'object' || res.data === null) {
				return c.json({ error: `.json listing returned ${res.status}` }, 502);
			}

			const { items, after: nextAfter, dist } = flattenListing(res.data);
			if (items.length === 0) {
				return c.json({ error: `Empty .json listing for r/${subreddit}/${sort}` }, 502);
			}
			return c.json(
				withCompleteness({
					subreddit,
					sort,
					items,
					returned: items.length,
					// `dist` is what this page contains, not a catalogue total —
					// Reddit publishes no total for a listing, so none is claimed.
					dist,
					hasMore: nextAfter !== null,
					nextAfter,
				}),
			);
		},
	},

	// ─── Route 7: Search — reached only by running the query ──────────────
	// Discovery found this by pressing Enter in the site's search box; the
	// endpoint never fires otherwise. The HTML at /search/ is not usable —
	// 474 KB with zero <shreddit-post>, because the result cards are built
	// client-side after hydration — so this consumes the JSON gateway
	// instead, which returns the same records as records.
	{
		method: 'GET',
		path: '/search',
		examples: ['/search?q=cats', '/search?q=mechanical+keyboard&sort=top&limit=10'],
		upstream: ['www.reddit.com/search.json', 'www.reddit.com/r/{subreddit}/search.json'],
		transport: 'JSON API (XHR)',
		description: 'Search posts sitewide or within a subreddit, over the .json gateway.',
		handler: async (c, browser) => {
			const url = new URL(c.req.url);
			const q = url.searchParams.get('q');
			if (!q) return c.json({ error: 'q is required' }, 400);
			const subreddit = url.searchParams.get('subreddit');
			const sort = url.searchParams.get('sort') ?? 'relevance';
			const limit = Math.min(Number(url.searchParams.get('limit') ?? '25'), 100);
			const after = url.searchParams.get('after');

			const target = new URL(
				subreddit
					? `${BASE_URL}/r/${encodeURIComponent(subreddit)}/search.json`
					: `${BASE_URL}/search.json`,
			);
			target.searchParams.set('q', q);
			target.searchParams.set('sort', sort);
			target.searchParams.set('limit', String(limit));
			target.searchParams.set('type', 'link');
			if (subreddit) target.searchParams.set('restrict_sr', '1');
			if (after) target.searchParams.set('after', after);

			DEBUG('reddit', `search: ${target}`);
			const res = await browser.browserFetch<RawListing>(target.toString());
			if (res.status !== 200 || typeof res.data !== 'object' || res.data === null) {
				return c.json({ error: `search.json returned ${res.status}` }, 502);
			}

			const { items, after: nextAfter, dist } = flattenListing(res.data);
			return c.json({
				query: q,
				subreddit,
				sort,
				items,
				returned: items.length,
				dist,
				hasMore: nextAfter !== null,
				nextAfter,
			});
		},
	},

	// ─── Route 8: GraphQL — the front end's own operation-name gateway ────
	// `/svc/shreddit/graphql` takes `{operation, variables, csrf_token}`: a
	// *name*, never a query document, resolved against a server-side
	// whitelist. Unknown names come back 500, so the reachable surface is
	// exactly what the shipped bundle references. Most of those record
	// experiment exposure or mint a captcha token; `SubredditByName` is the
	// one that returns records, and it returns the `t5_` id route 9 needs.
	{
		method: 'GET',
		path: '/gql/subreddit/:name',
		examples: ['/gql/subreddit/aww', '/gql/subreddit/AskReddit'],
		upstream: ['www.reddit.com/svc/shreddit/graphql'],
		transport: 'GraphQL',
		description: "Subreddit metadata (id, prefixed name, icons) over shreddit's GraphQL gateway.",
		handler: async (c, browser) => {
			const name = (c.req.param() as Record<string, string>).name;
			const csrfToken = await readCsrfToken(browser);
			if (!csrfToken) {
				return c.json({ error: 'Could not read csrf_token from the browser session' }, 502);
			}

			DEBUG('reddit', `gql: ${SHREDDIT_GQL_OPERATION}(${name})`);
			const res = await browser.browserFetch<{
				data?: { subredditInfoByName?: Record<string, unknown> };
				errors?: unknown[];
			}>(`${BASE_URL}/svc/shreddit/graphql`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation: SHREDDIT_GQL_OPERATION,
					variables: { name },
					csrf_token: csrfToken,
				}),
			});
			if (res.status !== 200 || typeof res.data !== 'object' || res.data === null) {
				return c.json(
					{
						error: `GraphQL gateway returned ${res.status}`,
						note: `A 500 here usually means Reddit retired the "${SHREDDIT_GQL_OPERATION}" operation name.`,
					},
					502,
				);
			}

			const info = res.data.data?.subredditInfoByName ?? null;
			if (!info) {
				return c.json({ error: `No subreddit record for r/${name}`, errors: res.data.errors }, 502);
			}
			return c.json({
				operation: SHREDDIT_GQL_OPERATION,
				name,
				subreddit: info,
				returned: 1,
				hasMore: false,
			});
		},
	},

	// ─── Route 9: Realtime — graphql-ws over Reddit's subscription gateway ─
	// The shreddit bundle carries a graphql-ws client pointed at
	// `wss://gql-realtime.reddit.com/query`, authenticated with a bearer
	// minted at `POST /svc/shreddit/token`. It is `lazy: true`, so it opens
	// only when something subscribes — nothing on a logged-out page does, and
	// no amount of passive browsing or generic provocation reaches it.
	//
	// The one subscription document in the shipped bundle is mod-scoped
	// (`teamOwner: MOD, category: MOD_UPDATE`). An anonymous identity
	// moderates nothing, so the gateway accepts the socket, accepts the
	// subscribe, and answers with a `next` frame carrying an authorization
	// error — which is the honest result for this identity and is reported as
	// such rather than dressed up as an empty stream.
	{
		method: 'GET',
		path: '/realtime/:subredditId',
		examples: ['/realtime/t5_2qh1o', '/realtime/t5_2qh1i?frames=2'],
		upstream: ['www.reddit.com/svc/shreddit/token', 'gql-realtime.reddit.com/query'],
		transport: 'WebSocket',
		description:
			"Reddit's graphql-ws subscription gateway: mint a bearer, subscribe, return the frames.",
		handler: async (c, browser) => {
			const subredditId = (c.req.param() as Record<string, string>).subredditId;
			const url = new URL(c.req.url);
			const maxFrames = Math.min(Number(url.searchParams.get('frames') ?? '3'), 10);
			const waitMs = Math.min(Number(url.searchParams.get('waitMs') ?? '12000'), 30_000);

			const csrfToken = await readCsrfToken(browser);
			if (!csrfToken) {
				return c.json({ error: 'Could not read csrf_token from the browser session' }, 502);
			}
			// Computed, not harvestable: the token is minted per session and
			// expires in 24 h, so it is fetched fresh rather than cached.
			const tokenRes = await browser.browserFetch<{ token?: string; expires?: number }>(
				`${BASE_URL}/svc/shreddit/token`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
					body: JSON.stringify({ csrf_token: csrfToken }),
				},
			);
			const bearer = tokenRes.data?.token;
			if (tokenRes.status !== 200 || !bearer) {
				return c.json({ error: `Token mint returned ${tokenRes.status}` }, 502);
			}

			const { default: WebSocket } = await import('ws');
			const frames: unknown[] = [];
			let acknowledged = false;

			await new Promise<void>((resolve) => {
				const ws = new WebSocket(REALTIME_WS_URL, 'graphql-transport-ws', {
					origin: BASE_URL,
				});
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					try {
						ws.close();
					} catch {
						/* already closing */
					}
					resolve();
				};
				const timer = setTimeout(finish, waitMs);

				ws.on('open', () => {
					ws.send(
						JSON.stringify({
							type: 'connection_init',
							payload: { Authorization: `Bearer ${bearer}` },
						}),
					);
				});
				ws.on('message', (raw: Buffer) => {
					let msg: Record<string, unknown>;
					try {
						msg = JSON.parse(raw.toString()) as Record<string, unknown>;
					} catch {
						frames.push({ type: 'non-json', base64: raw.toString('base64').slice(0, 512) });
						return;
					}
					if (msg.type === 'connection_ack') {
						acknowledged = true;
						ws.send(
							JSON.stringify({
								id: '1',
								type: 'subscribe',
								payload: {
									query:
										'subscription S($input: SubscribeInput!) { subscribe(input: $input) { id ... on BasicMessage { data { __typename } } } }',
									variables: {
										input: {
											channel: {
												teamOwner: 'MOD',
												category: 'MOD_UPDATE',
												subredditID: subredditId,
											},
										},
									},
								},
							}),
						);
						return;
					}
					frames.push(msg);
					if (msg.type === 'complete' || frames.length >= maxFrames) finish();
				});
				ws.on('error', (err: Error) => {
					frames.push({ type: 'socket-error', message: err.message });
					finish();
				});
				ws.on('close', finish);
			});

			return c.json({
				endpoint: REALTIME_WS_URL,
				protocol: 'graphql-transport-ws',
				subredditId,
				handshake: acknowledged ? 'connection_ack' : 'no ack',
				frames,
				returned: frames.length,
				hasMore: false,
				note: acknowledged
					? 'The gateway authenticated the anonymous bearer. MOD_UPDATE is the only channel the shipped bundle subscribes to, and it yields an authorization error for an identity that moderates nothing.'
					: 'The socket opened but never acknowledged — the bearer was refused.',
			});
		},
	},

	// ─── Route 10: Video — master playlist → variant → a segment that loads ─
	// Chased to bytes on purpose: a master playlist alone proves a manifest
	// exists, not that anything plays. This resolves a variant, reads its
	// media playlist, and fetches the first segment, reporting its length.
	//
	// v.redd.it answers direct HTTP 200 with no session, so this route is off
	// the browser rung — but the *signed* playlist URL that a post record
	// carries is not needed: the unsigned path under the video id works.
	{
		method: 'GET',
		path: '/video/:id',
		examples: ['/video/588ej9n4j0gh1'],
		upstream: [
			'v.redd.it/{id}/HLSPlaylist.m3u8',
			// The variant playlists and their segments, which the master names and
			// this route follows. Listed because the browser fetches these same
			// shapes when the player runs — including the audio-only renditions,
			// which the master carries alongside the video ones.
			'v.redd.it/{id}/{rendition}.m3u8',
			'v.redd.it/{id}/{rendition}.mp4',
		],
		transport: 'HLS/Media',
		browserRequired: false,
		description:
			"A video post's HLS renditions, with the lowest variant's first segment fetched to prove it plays.",
		handler: async (c) => {
			const id = (c.req.param() as Record<string, string>).id;
			const masterUrl = `https://v.redd.it/${encodeURIComponent(id)}/HLSPlaylist.m3u8`;

			DEBUG('reddit', `video: ${masterUrl}`);
			const masterRes = await fetch(masterUrl, {
				headers: DIRECT_HEADERS,
				signal: AbortSignal.timeout(30_000),
			});
			if (masterRes.status !== 200) {
				return c.json({ error: `Master playlist returned ${masterRes.status}` }, 502);
			}
			const variants = parseHlsMaster(await masterRes.text());
			if (variants.length === 0) return c.json({ error: 'Master playlist named no variants' }, 502);

			// Lowest bandwidth: the point is that a segment loads, not that it is
			// the best one, and the smallest costs the site least.
			const pick = [...variants].sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0))[0];
			const variantUrl = new URL(pick.uri, masterUrl).toString();
			const variantRes = await fetch(variantUrl, {
				headers: DIRECT_HEADERS,
				signal: AbortSignal.timeout(30_000),
			});
			if (variantRes.status !== 200) {
				return c.json({ error: `Variant playlist returned ${variantRes.status}` }, 502);
			}
			const variantBody = await variantRes.text();
			const segmentLines = variantBody
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l && !l.startsWith('#'));
			const initLine = variantBody.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1] ?? null;
			const firstSegment = initLine ?? segmentLines[0] ?? null;

			let segment: { url: string; status: number; bytes: number; contentType: string } | null =
				null;
			if (firstSegment) {
				const segUrl = new URL(firstSegment, variantUrl).toString();
				const segRes = await fetch(segUrl, {
					headers: { ...DIRECT_HEADERS, Range: 'bytes=0-262143' },
					signal: AbortSignal.timeout(30_000),
				});
				const buf = await segRes.arrayBuffer();
				segment = {
					url: segUrl,
					status: segRes.status,
					bytes: buf.byteLength,
					contentType: segRes.headers.get('content-type') ?? '',
				};
			}

			return c.json({
				id,
				masterUrl,
				variants,
				returned: variants.length,
				hasMore: false,
				played: {
					variantUrl,
					variantBandwidth: pick.bandwidth,
					segmentCount: segmentLines.length,
					segment,
				},
			});
		},
	},
];
