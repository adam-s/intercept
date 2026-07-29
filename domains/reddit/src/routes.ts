/**
 * Reddit API Routes
 *
 * Discovery (see the domain's elimination table in the PR/report) found no
 * JSON API and no embedded JSON blob behind reddit.com's own front end
 * ("shreddit"). Every data-bearing request — feeds, a post's comments,
 * search — comes back as an HTML fragment: a page of `<shreddit-post>` or
 * `<shreddit-comment>` custom elements whose attributes carry the fields a
 * JSON API would put in a body. The wire content type says as much:
 * `text/vnd.reddit.partial+html`. This is the "HTML-over-the-wire" transport
 * — cheerio does the parsing a JSON.parse would normally do.
 *
 * Reddit issues a JS challenge (recaptcha-enterprise-backed) to the first
 * navigation from a fresh automated context; a disposable Patchright
 * instance launched per-request gets a hard network-security block, not the
 * challenge (verified empirically — see the domain's discovery report). The
 * long-running, already-connected discovery browser passes it once and
 * carries the resulting cookies for the rest of the session. So every route
 * here runs through `browser.browserFetch()` (browserRequired stays at its
 * default of `true`) rather than harvesting cookies for direct HTTP — the
 * session isn't reusable outside the browser that earned it.
 *
 * Pagination is cursor-based throughout: the first page comes from the
 * normal SSR document (`/r/:subreddit/`, `/r/popular/`, a post permalink);
 * continuation pages come from the `/svc/shreddit/*` partial endpoints whose
 * cursor is embedded either in a `<faceplate-partial src=".../after=...">`
 * (feeds) or a `<input type="hidden" name="cursor">` inside one (comments).
 *
 * Search was investigated and dropped: `/svc/shreddit/search/` returns only
 * `SML.load(...)` bundle-loader stubs — the actual result cards are built by
 * a client-side "HuiGrid" component after hydration, not present in any
 * fetched HTML. That would need its own interaction-gated discovery pass;
 * out of scope here (see the domain's coverage notes).
 *
 * @module domain-reddit/routes
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import { DEBUG } from '@interceptor/shared';
import { load } from 'cheerio';

const BASE_URL = 'https://www.reddit.com';

/** The partial-HTML endpoints only render fragments for this Accept header — see config.ts note. */
const PARTIAL_HEADERS = { Accept: 'text/vnd.reddit.partial+html, text/html;q=0.9' };
/** First-page fetches want the full SSR document. */
const DOC_HEADERS = { Accept: 'text/html' };

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
 * Parse `<shreddit-post>` cards out of an SSR document or a
 * `community-more-posts` / `popular-feed` partial — both render the same
 * custom element, just wrapped in a full `<html>` vs. a bare fragment.
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
	// that the front end swaps in when it scrolls into view — we never click it,
	// just read the URL it would have fetched.
	const nextSrc = $('faceplate-partial[slot="load-after"]').attr('src') ?? null;
	const nextUrl = nextSrc ? new URL(nextSrc, BASE_URL).toString() : null;
	return { posts, nextUrl };
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
 * Parse `<shreddit-comment>` elements out of a post page or a
 * `more-comments` partial. Comment body text lives in a nested
 * `#{thingId}-post-rtjson-content` div, not an attribute — that div is where
 * the front end's rich-text renderer writes the markdown-to-HTML output.
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

	// Top-level pagination: <faceplate-partial id="top-level-more-comments-partial"
	// src="/svc/shreddit/more-comments/...?top-level=1&..." method="post">
	//   <input type="hidden" name="cursor" value="...">
	const moreEl = $('#top-level-more-comments-partial');
	const moreSrc = moreEl.attr('src');
	const cursor = moreEl.find('input[name="cursor"]').attr('value') ?? null;
	const more = moreSrc ? { url: new URL(moreSrc, BASE_URL).toString(), cursor } : null;

	return { comments, more };
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
 * A bare same-origin `fetch()` of this URL (what browserFetch does) returns a
 * shell: the post and its comments are absent, replaced by a single
 * `<faceplate-partial name="ActivateExperience_..." src="/svc/shreddit/partial/.../activate-experience?...&sig=...">`
 * that the front end's own JS resolves after the page loads — confirmed by
 * fetching that partial URL directly and getting an empty body back outside
 * a real page context. So this route needs an actual navigation, not a
 * fetch: the content lives in the post-hydration DOM, the same class of case
 * ARCHITECTURE.md calls out for `browser.evaluate()` over `browserFetch()`.
 *
 * The activate-experience fetch itself replaces part of the DOM, which tears
 * down Playwright's JS execution context mid-flight — an `evaluate()` racing
 * that swap fails with "Execution context was destroyed", not a timeout. So
 * this polls with fresh, short-lived `evaluate()` calls (each one gets a
 * current context) instead of one `evaluate()` holding a sleep across the
 * swap, and tolerates that specific error as "not settled yet" rather than
 * a real failure.
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
				() => document.querySelectorAll('shreddit-post, shreddit-comment').length > 0,
			);
			if (ready) break;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes('Execution context was destroyed')) throw err;
			// The hydration swap tore down the context we just queried against —
			// exactly the "not settled yet" case this loop exists for. Retry.
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
	// Unreachable — the loop above always returns or throws on its last attempt.
	throw new Error('fetchHydratedPostPage: unreachable');
}

export const routes: DomainRoute[] = [
	// ─── Route 1: Subreddit post feed — HTML-over-the-wire, cursor pagination ─
	// Page 1 is the SSR document at /r/:subreddit/. Page 2+ comes from
	// /svc/shreddit/community-more-posts/:sort/, whose after+cursor pair the
	// caller round-trips from this route's own `nextCursor` in the response.
	{
		method: 'GET',
		path: '/r/:subreddit',
		examples: ['/r/AskReddit', '/r/interesting'],
		upstream: [
			'www.reddit.com/r/{subreddit}/',
			'www.reddit.com/svc/shreddit/community-more-posts/{sort}/',
		],
		transport: 'HTML-over-the-wire',
		description: 'Subreddit post feed. Pass ?after=&cursor= from a prior response to page.',
		handler: async (c, browser) => {
			const subreddit = (c.req.param() as Record<string, string>).subreddit;
			const url = new URL(c.req.url);
			const after = url.searchParams.get('after');
			// `cursor` is usually the same opaque token as `after`, but the SSR
			// document's own `load-after` partial sometimes omits it entirely —
			// the community-more-posts endpoint accepts `after` alone. Default it
			// rather than requiring the caller to supply a param the site itself
			// doesn't always send.
			const cursor = url.searchParams.get('cursor') ?? after;
			const sort = (url.searchParams.get('sort') ?? 'best').toLowerCase();

			const paging = Boolean(after);
			const fetchUrl = paging
				? `${BASE_URL}/svc/shreddit/community-more-posts/${encodeURIComponent(sort)}/?after=${encodeURIComponent(after ?? '')}&cursor=${encodeURIComponent(cursor ?? '')}&name=${encodeURIComponent(subreddit)}&t=DAY&feedLength=4`
				: `${BASE_URL}/r/${encodeURIComponent(subreddit)}/`;

			DEBUG('reddit', `r/${subreddit}: fetching ${fetchUrl}`);
			const res = await browser.browserFetch<string>(fetchUrl, {
				headers: paging ? PARTIAL_HEADERS : DOC_HEADERS,
			});
			if (res.status !== 200 || typeof res.data !== 'string') {
				return c.json({ error: `Feed request returned ${res.status}` }, 502);
			}

			const { posts, nextUrl } = parsePostsHtml(res.data);
			const nextParams = nextUrl ? Object.fromEntries(new URL(nextUrl).searchParams) : null;

			return c.json({
				subreddit,
				sort,
				posts,
				returned: posts.length,
				hasMore: nextUrl !== null,
				nextCursor: nextParams
					? { after: nextParams.after, cursor: nextParams.cursor ?? nextParams.after }
					: null,
			});
		},
	},

	// ─── Route 2: r/popular frontpage feed — same transport, different endpoint family ─
	{
		method: 'GET',
		path: '/popular',
		examples: ['/popular'],
		upstream: ['www.reddit.com/r/popular/', 'www.reddit.com/svc/shreddit/feeds/popular-feed'],
		transport: 'HTML-over-the-wire',
		description: 'r/popular frontpage feed. Pass ?after=&cursor= from a prior response to page.',
		handler: async (c, browser) => {
			const url = new URL(c.req.url);
			const after = url.searchParams.get('after');
			// See the same default in Route 1 — the site doesn't always send `cursor`.
			const cursor = url.searchParams.get('cursor') ?? after;
			const sort = (url.searchParams.get('sort') ?? 'BEST').toUpperCase();

			const paging = Boolean(after);
			const fetchUrl = paging
				? `${BASE_URL}/svc/shreddit/feeds/popular-feed?after=${encodeURIComponent(after ?? '')}&cursor=${encodeURIComponent(cursor ?? '')}&distance=4&adDistance=2&navigationSessionId=${crypto.randomUUID()}&sort=${encodeURIComponent(sort)}`
				: `${BASE_URL}/r/popular/`;

			DEBUG('reddit', `popular: fetching ${fetchUrl}`);
			const res = await browser.browserFetch<string>(fetchUrl, {
				headers: paging ? PARTIAL_HEADERS : DOC_HEADERS,
			});
			if (res.status !== 200 || typeof res.data !== 'string') {
				return c.json({ error: `Feed request returned ${res.status}` }, 502);
			}

			const { posts, nextUrl } = parsePostsHtml(res.data);
			const nextParams = nextUrl ? Object.fromEntries(new URL(nextUrl).searchParams) : null;

			return c.json({
				sort,
				posts,
				returned: posts.length,
				hasMore: nextUrl !== null,
				nextCursor: nextParams
					? { after: nextParams.after, cursor: nextParams.cursor ?? nextParams.after }
					: null,
			});
		},
	},

	// ─── Route 3: Post detail + first page of comments — SSR document ─────
	{
		method: 'GET',
		path: '/post/:subreddit/:id',
		examples: ['/post/interesting/1v9qi7a'],
		upstream: ['www.reddit.com/r/{subreddit}/comments/{id}/'],
		transport: 'HTML-over-the-wire',
		description:
			'Post detail + first page of top-level comments (rendered DOM — see fetchHydratedPostPage).',
		handler: async (c, browser) => {
			const params = c.req.param() as Record<string, string>;
			const subreddit = params.subreddit;
			const id = params.id.replace(/^t3_/, '');
			const url = `${BASE_URL}/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(id)}/`;

			DEBUG('reddit', `post: navigating to ${url}`);
			const html = await fetchHydratedPostPage(browser, url);

			const { posts } = parsePostsHtml(html);
			const post = posts.find((p) => p.id === `t3_${id}`) ?? posts[0] ?? null;
			const { comments, more } = parseCommentsHtml(html);

			return c.json({
				subreddit,
				post,
				comments,
				returned: comments.length,
				hasMore: more !== null,
				moreCursor: more?.cursor ?? null,
			});
		},
	},

	// ─── Route 4: Comments continuation — Form-encoded POST ───────────────
	// The front end reads `csrf_token` out of `document.cookie` and echoes it
	// into the POST body alongside the cursor from the hidden <input> — see
	// the module docblock. We re-fetch the post page to get a fresh
	// cursor+csrf pair rather than trusting a caller-supplied one, since both
	// are single-use/session-scoped and go stale fast.
	{
		method: 'POST',
		path: '/post/:subreddit/:id/comments/more',
		examples: ['/post/interesting/1v9qi7a/comments/more'],
		upstream: [
			'www.reddit.com/r/{subreddit}/comments/{id}/',
			'www.reddit.com/svc/shreddit/more-comments/{subreddit}/{id}',
		],
		transport: 'Form-encoded POST',
		description: 'Load the next page of top-level comments (cursor + csrf_token form POST).',
		handler: async (c, browser) => {
			const params = c.req.param() as Record<string, string>;
			const subreddit = params.subreddit;
			const id = params.id.replace(/^t3_/, '');
			const postUrl = `${BASE_URL}/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(id)}/`;

			DEBUG('reddit', `comments/more: refreshing cursor from ${postUrl}`);
			const html = await fetchHydratedPostPage(browser, postUrl);
			const { more } = parseCommentsHtml(html);
			if (!more || !more.cursor) {
				return c.json({ comments: [], returned: 0, hasMore: false, note: 'No further comments.' });
			}

			// document.cookie only returns the cookies for the page's current
			// origin — fetchHydratedPostPage above already landed us on www.reddit.com.
			const cookieStr = await browser.evaluate(() => document.cookie);
			const csrfToken = cookieStr
				.split('; ')
				.find((kv) => kv.startsWith('csrf_token='))
				?.slice('csrf_token='.length);
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

	// ─── Route 5: Video renditions — HLS master playlist → variants ───────
	// `<shreddit-post content-href="https://v.redd.it/{id}">` is the base URL
	// for a video post; the master playlist lives at a fixed, unsigned path
	// under it once the browser is on the v.redd.it origin (verified: the
	// same request cross-origin from www.reddit.com is blocked by CORS,
	// which is why this needs the browser rather than a bare fetch).
	{
		method: 'GET',
		path: '/video/:id',
		examples: ['/video/m0vorh4e41gh1'],
		upstream: ['v.redd.it/{id}/HLSPlaylist.m3u8'],
		transport: 'HLS/Media',
		description: "Video post renditions: v.redd.it's HLS master playlist, parsed into variants.",
		handler: async (c, browser) => {
			const id = (c.req.param() as Record<string, string>).id;
			const masterUrl = `https://v.redd.it/${encodeURIComponent(id)}/HLSPlaylist.m3u8`;

			DEBUG('reddit', `video: fetching ${masterUrl}`);
			const res = await browser.browserFetch<string>(masterUrl);
			if (res.status !== 200 || typeof res.data !== 'string') {
				return c.json({ error: `Master playlist returned ${res.status}` }, 502);
			}

			const variants = parseHlsMaster(res.data);
			return c.json({
				id,
				masterUrl,
				variants,
				returned: variants.length,
				hasMore: false,
			});
		},
	},
];
