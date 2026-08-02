/**
 * fixture-api's builders, driven with no server.
 *
 * The point of these is not that the fixture works — it is that the fixture
 * keeps exhibiting the properties it exists to exhibit. A fixture quietly
 * losing its awkward instance is the worst outcome available here: every screen
 * built against it then renders correctly, and the case that breaks them is
 * simply never on screen. So each assertion below names the property, and goes
 * red when the fixture starts being convenient.
 */

import { describe, expect, it } from 'vitest';
import {
	fixtureImage,
	hackernewsList,
	parseArgs,
	redditFeed,
	resolve,
	STATES,
	seeded,
	stateOf,
	svgFor,
	twitchCategory,
	youtubeSearch,
} from '../fixture-api.mjs';

describe('state selection', () => {
	it('reads a state out of a prefixed identifier', () => {
		for (const s of STATES) expect(stateOf(`__${s}`)).toBe(s);
	});

	it('treats every ordinary identifier as populated', () => {
		for (const id of ['top', 'aww', 'just-chatting', 'lofi', '', '__nonsense', undefined]) {
			expect(stateOf(id)).toBe('populated');
		}
	});
});

describe('determinism', () => {
	it('generates the same content twice, so two captures are comparable', () => {
		expect(hackernewsList('top')).toEqual(hackernewsList('top'));
		expect(twitchCategory('just-chatting')).toEqual(twitchCategory('just-chatting'));
		expect(youtubeSearch('lofi')).toEqual(youtubeSearch('lofi'));
		expect(redditFeed('aww')).toEqual(redditFeed('aww'));
	});

	it('seeded draws vary within a run', () => {
		const rand = seeded(5);
		const draws = new Set([rand(), rand(), rand(), rand()]);
		expect(draws.size).toBe(4);
	});
});

describe('the awkward instances survive', () => {
	it('keeps a Hacker News item with no points and no author', () => {
		const bylineless = hackernewsList('top').items.filter(
			(i) => i.points === null && i.author === null,
		);
		expect(bylineless.length).toBeGreaterThan(0);
	});

	it('keeps a YouTube result carrying neither channel nor duration', () => {
		const { videos } = youtubeSearch('lofi');
		expect(videos.some((v) => v.channel === undefined && v.duration === undefined)).toBe(true);
		expect(videos.some((v) => typeof v.channel === 'string')).toBe(true);
	});

	it('keeps a Twitch card with no tags and one with more than fit', () => {
		const { items } = twitchCategory('just-chatting', 'edge');
		expect(items.some((i) => i.freeformTags.length === 0)).toBe(true);
		expect(items.some((i) => i.freeformTags.length > 4)).toBe(true);
	});

	it('keeps a picture that refuses, in every collection that shows pictures', () => {
		const refuses = (href) => typeof href === 'string' && href.includes('__404');
		expect(twitchCategory('x', 'edge').items.some((i) => refuses(i.previewImageURL))).toBe(true);
		expect(redditFeed('x', 'edge').posts.some((p) => refuses(p.contentHref))).toBe(true);
		expect(youtubeSearch('x', 'edge').videos.some((v) => refuses(v.thumbnail))).toBe(true);
		expect(svgFor('__404', 10, 10)).toBeNull();
	});

	it('keeps a title long enough to force the truncation decision', () => {
		for (const title of [
			hackernewsList('top', 'edge').items[0].title,
			redditFeed('x', 'edge').posts[0].title,
			twitchCategory('x', 'edge').items[0].title,
			youtubeSearch('x', 'edge').videos[0].title,
		]) {
			expect(title.length).toBeGreaterThan(120);
		}
	});
});

describe('each state is distinguishable from the others', () => {
	it('empty returns a collection with nothing in it, not an error', () => {
		expect(hackernewsList('top', 'empty').items).toEqual([]);
		expect(redditFeed('aww', 'empty').posts).toEqual([]);
		expect(twitchCategory('x', 'empty').items).toEqual([]);
		expect(youtubeSearch('q', 'empty').videos).toEqual([]);
	});

	it('partial reports more than it hands over', () => {
		const hn = hackernewsList('top', 'partial');
		expect(hn.returned).toBeGreaterThan(hn.items.length);
		const rd = redditFeed('aww', 'partial');
		expect(rd.returned).toBeGreaterThan(rd.posts.length);
		const tw = twitchCategory('x', 'partial');
		expect(tw.returned).toBeGreaterThan(tw.items.length);
		expect(tw._note).toBeTruthy();
		const yt = youtubeSearch('q', 'partial');
		expect(yt.indicatedTotal).toBeGreaterThan(yt.videos.length);
		expect(yt.hasMore).toBe(true);
	});

	it('populated never claims to be short', () => {
		expect(hackernewsList('top').returned).toBe(hackernewsList('top').items.length);
		expect(twitchCategory('x').returned).toBe(twitchCategory('x').items.length);
		expect(twitchCategory('x')._note).toBeUndefined();
	});
});

describe('routing', () => {
	it('serves every screen its own route', () => {
		expect(resolve('/api/hackernews/list/top', '').status).toBe(200);
		expect(resolve('/api/reddit/popular', '').status).toBe(200);
		expect(resolve('/api/reddit/r/aww', '').status).toBe(200);
		expect(resolve('/api/twitch/directory/just-chatting/streams', '').status).toBe(200);
		expect(resolve('/api/youtube/search', '?q=lofi').status).toBe(200);
		expect(resolve('/api/youtube/suggest', '?q=lofi').status).toBe(200);
	});

	it('refuses when the identifier selects the error state', () => {
		expect(resolve('/api/twitch/directory/__error/streams', '').status).toBe(502);
		expect(resolve('/api/hackernews/list/__error', '').status).toBe(502);
		expect(resolve('/api/youtube/search', '?q=__error').status).toBe(502);
	});

	it('holds past any settle delay when the identifier selects the in-flight state', () => {
		const hit = resolve('/api/reddit/r/__slow', '');
		expect(hit.body).toBeUndefined();
		expect(hit.delayMs).toBeGreaterThan(30_000);
	});

	it('serves each screen its detail route too', () => {
		expect(resolve('/api/hackernews/item/1000', '').status).toBe(200);
		expect(resolve('/api/reddit/post/aww/2000', '').status).toBe(200);
		expect(resolve('/api/twitch/channel/tern/videos', '').status).toBe(200);
		expect(resolve('/api/youtube/watch/yt-4000/info', '').status).toBe(200);
		expect(resolve('/api/yahoofinance/screener/MOST_ACTIVES', '').status).toBe(200);
		expect(resolve('/api/yahoofinance/chart/AAPL', '').status).toBe(200);
		expect(resolve('/api/boardshop/catalog', '').status).toBe(200);
		expect(resolve('/api/boardshop/product/DECK-101', '').status).toBe(200);
	});

	it('returns null for a path it does not serve, rather than an empty body', () => {
		// A route the real API has and this fixture does not: the caller has to be
		// told, because a fixture answering an unmodelled path with an empty body
		// reads exactly like a screen whose data genuinely came back empty.
		expect(resolve('/api/hackernews/front', '')).toBeNull();
		expect(resolve('/api/nope', '')).toBeNull();
	});

	it('names the missing parameter rather than serving an empty result', () => {
		expect(resolve('/api/youtube/search', '').status).toBe(400);
	});
});

describe('images', () => {
	it('points at a path the app proxy actually forwards', () => {
		// Only /api/* and /browser/* are rewritten to the API port; a picture
		// anywhere else is fetched from the web server and 404s.
		expect(fixtureImage('a')).toMatch(/^\/api\//);
	});

	it('renders at the aspect it was asked for', () => {
		expect(svgFor('a', 640, 360)).toContain('width="640" height="360"');
	});
});

describe('bounds', () => {
	it('defaults to a request cap and a wall-clock ceiling', () => {
		const opts = parseArgs([]);
		expect(opts.maxRequests).toBeGreaterThan(0);
		expect(opts.wallClock).toBeGreaterThan(0);
	});

	it('takes them from flags', () => {
		const opts = parseArgs(['--port=3999', '--max-requests=5', '--wall-clock=60']);
		expect(opts).toMatchObject({ port: 3999, maxRequests: 5, wallClock: 60_000 });
	});
});
