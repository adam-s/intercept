#!/usr/bin/env node
/**
 * fixture-api — the domain routes' declared shapes, served locally.
 *
 * PURPOSE
 *   A dashboard is judged by looking at it, and looking at it means loading it.
 *   Pointed at the real API, every look costs a live request to a third party,
 *   which makes the states that matter most the ones hardest to see: a route
 *   that is answering correctly will not produce an empty collection, a refusal,
 *   or a page that is still in flight on demand. So those states get built once,
 *   guessed at, and never rendered — and a screen is shipped having only ever
 *   been seen in the one state its upstream happened to be in.
 *
 *   This serves the same paths from the shapes recorded in
 *   data/route-spec-baseline/, so a screen can be rendered as many times as it
 *   takes, in every state, at every viewport, with no outbound request at all.
 *   Point the web app at it with `API_PORT=<this port> pnpm --filter @interceptor/web dev`.
 *
 *   It is a rendering aid and not a check: it proves nothing about a live route.
 *   The asserting tier over real routes is route-spec.mjs, and a shape here that
 *   drifts from the baseline is a defect in this file.
 *
 * STATE IS SELECTED BY THE SAME PARAMETER A READER VARIES
 *   Every screen already takes one identifier from its URL — a list type, a
 *   subreddit, a category, a query. A value prefixed `__` selects a state
 *   instead of content, so one capture run reaches every state through the
 *   page's own code path, with no restart and no control file:
 *
 *     /reddit?r=__empty      the collection came back with nothing in it
 *     /twitch?category=__error    the route refused
 *     /hackernews?type=__partial  fewer items arrived than the route reported
 *     /youtube?q=__slow      still in flight (holds past any settle delay)
 *     /reddit?r=__edge       the awkward instances: long text, absent options
 *
 *   `__slow` is what makes a loading state observable at all: a fixture that
 *   answers instantly cannot exhibit a behaviour defined by waiting.
 *
 * IMAGES
 *   Upstream media hosts are not reachable from here either, and a card with no
 *   picture is a different card. `/api/__fixture/img` serves generated SVG at a
 *   requested aspect. One well-known seed (`__404`) refuses, because the
 *   picture-failed path is a state too and it is the one that reflows a grid.
 *
 * BOUNDS
 *   Serves at most --max-requests (default 2000) and exits after --wall-clock
 *   seconds (default 1800) whatever happens, so an unattended run cannot leave a
 *   port bound. Deterministic: content comes from a seeded generator, never from
 *   a clock or a random source, so two captures of one state are comparable.
 *
 * Importing this module runs nothing — the pure builders are exported so
 * scripts/__tests__/fixture-api.test.mjs drives them with no server.
 */

import { createServer } from 'node:http';

// ─── Arg parsing ─────────────────────────────────────────────────────

/** The uniform 4-line argv parser every script in this folder shares. */
export function parseArgs(argv) {
	const flags = {};
	for (const arg of argv) {
		const raw = arg.replace(/^--/, '');
		const eq = raw.indexOf('=');
		if (eq === -1) flags[raw] = true;
		else flags[raw.slice(0, eq)] = raw.slice(eq + 1);
	}
	return {
		port: Number(flags.port ?? 3101),
		maxRequests: Number(flags['max-requests'] ?? 2000),
		wallClock: Number(flags['wall-clock'] ?? 1800) * 1000,
		help: flags.help === true || flags.h === true,
	};
}

// ─── State selection ─────────────────────────────────────────────────

/** The states a screen has to be looked at in, beyond the populated one. */
export const STATES = ['empty', 'error', 'partial', 'slow', 'edge'];

/**
 * Read the state out of the identifier a screen passes through. Pure.
 *
 * Returns `populated` for any ordinary value, so the prefix is the only way in
 * and real content can never accidentally select a state.
 */
export function stateOf(identifier) {
	if (typeof identifier !== 'string' || !identifier.startsWith('__')) return 'populated';
	const name = identifier.slice(2);
	return STATES.includes(name) ? name : 'populated';
}

// ─── Deterministic content ───────────────────────────────────────────

/**
 * A seeded generator, so one state renders identically on every capture.
 *
 * `Math.random` would make two shots of the same screen differ for reasons that
 * have nothing to do with the change being reviewed.
 */
export function seeded(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

/** Pick from a list by seeded draw. */
function pick(rand, list) {
	return list[Math.floor(rand() * list.length) % list.length];
}

const NOUN = ['parser', 'ledger', 'kernel', 'raft log', 'index', 'scheduler', 'cache', 'codec'];
const VERB = ['rewrote', 'measured', 'shrank', 'traced', 'replaced', 'unpicked', 'bounded'];
const QUAL = ['in one pass', 'without a lock', 'from first principles', 'by hand', 'in 40 lines'];
const WHO = ['tern', 'okapi', 'saltmarsh', 'quinault', 'harbour', 'dunlin', 'basalt', 'yarrow'];
const HOST = ['example.org', 'example.com', 'example.net', null];

/** One synthetic headline. Obviously invented — it stands in for length, not content. */
function headline(rand) {
	return `I ${pick(rand, VERB)} a ${pick(rand, NOUN)} ${pick(rand, QUAL)}`;
}

/** The long value every list needs one of: the thing that elides or wraps. */
const LONG_TITLE =
	'A title long enough to prove the row truncates rather than wrapping, and to show which of the two neighbouring elements yields its width first when there is not enough of it to go round';

/** A picture this server can actually serve. `__404` refuses, on purpose. */
export function fixtureImage(seed, w = 640, h = 360) {
	return `/api/__fixture/img?seed=${encodeURIComponent(seed)}&w=${w}&h=${h}`;
}

// ─── Response builders, one per screen's route ───────────────────────

/**
 * `GET /api/hackernews/list/:type` — a dense ranked list.
 *
 * The two item variants the real route serves are both present in `populated`,
 * because they are the ones a build gets wrong: a job post carries neither
 * `points` nor `author`, and a fresh story has a `commentCount` of 0.
 */
export function hackernewsList(type, state = 'populated') {
	if (state === 'empty') {
		return { type, items: [], returned: 0, hasMore: false, nextPage: null, paginationMode: 'page' };
	}
	const rand = seeded(11);
	const count = state === 'edge' ? 6 : 30;
	const items = Array.from({ length: count }, (_, i) => {
		const isJob = state !== 'edge' && i === 7;
		const site = pick(rand, HOST);
		return {
			id: `hn-${1000 + i}`,
			rank: i + 1,
			title: state === 'edge' && i === 0 ? LONG_TITLE : headline(rand),
			url: `https://${site ?? 'example.org'}/post/${1000 + i}`,
			site: state === 'edge' && i === 1 ? null : site,
			points: isJob ? null : Math.floor(rand() * 900) + 3,
			author: isJob ? null : pick(rand, WHO),
			ageISO: '2026-07-29T12:00:00.000Z',
			ageText: `${i + 1} hours ago`,
			commentCount: state === 'edge' && i === 2 ? 0 : Math.floor(rand() * 300),
			commentsUrl: `item?id=${1000 + i}`,
		};
	});
	// `partial` is the case a screen cannot show by accident: the route says it
	// returned more than it handed over, and silence there reads as a short day.
	const returned = state === 'partial' ? count + 12 : count;
	return {
		type,
		items,
		returned,
		hasMore: true,
		nextPage: 2,
		paginationMode: 'page',
	};
}

/** `GET /api/reddit/popular` and `/r/:sub` — a uniform feed of mixed post types. */
export function redditFeed(subreddit, state = 'populated') {
	const base = { sort: 'hot', ...(subreddit ? { subreddit } : {}) };
	if (state === 'empty') {
		return { ...base, posts: [], returned: 0, hasMore: false, nextCursor: null };
	}
	const rand = seeded(23);
	const kinds = ['image', 'link', 'text', 'video'];
	const count = state === 'edge' ? 5 : 12;
	const posts = Array.from({ length: count }, (_, i) => {
		const postType = state === 'edge' ? kinds[i % kinds.length] : pick(rand, kinds);
		const nsfw = state === 'edge' ? i === 3 : i === 9;
		const showsMedia = postType === 'image' || postType === 'video';
		return {
			id: `rd-${2000 + i}`,
			title: state === 'edge' && i === 0 ? LONG_TITLE : headline(rand),
			permalink: `/r/${subreddit || 'popular'}/comments/${2000 + i}/synthetic/`,
			author: pick(rand, WHO),
			subreddit: `r/${subreddit || pick(rand, ['aww', 'programming', 'askreddit'])}`,
			score: state === 'edge' && i === 1 ? 0 : Math.floor(rand() * 48_000),
			commentCount: state === 'edge' && i === 2 ? 0 : Math.floor(rand() * 4000),
			createdAt: '2026-07-29T09:30:00.000Z',
			domain: state === 'edge' && i === 1 ? null : pick(rand, HOST),
			postType,
			// One picture refuses, because a feed that reflows when a thumbnail
			// fails is a defect only the failing case shows.
			contentHref: showsMedia
				? fixtureImage(state === 'edge' && i === 4 ? '__404' : `rd${i}`, 300, 300)
				: null,
			nsfw,
		};
	});
	return {
		...base,
		posts,
		returned: state === 'partial' ? count + 8 : count,
		hasMore: true,
		nextCursor: { after: 't3_synthetic' },
	};
}

/** `GET /api/twitch/directory/:slug/streams` — a uniform grid of picture-first cards. */
export function twitchCategory(slug, state = 'populated') {
	const game = slug
		.split('-')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
	if (state === 'empty') {
		return { slug, game, items: [], returned: 0, hasMore: false };
	}
	const rand = seeded(37);
	const count = state === 'edge' ? 3 : 9;
	const items = Array.from({ length: count }, (_, i) => {
		const name = pick(rand, WHO);
		const tagCount = state === 'edge' ? [0, 2, 9][i] : Math.floor(rand() * 5);
		return {
			id: `tw-${3000 + i}`,
			title: state === 'edge' && i === 0 ? LONG_TITLE : headline(rand),
			viewersCount: state === 'edge' ? [4, 1200, 2_400_000][i] : Math.floor(rand() * 90_000) + 40,
			previewImageURL: fixtureImage(state === 'edge' && i === 1 ? '__404' : `tw${i}`, 640, 360),
			type: 'live',
			broadcaster: {
				login: name,
				displayName: name.charAt(0).toUpperCase() + name.slice(1),
				profileImageURL: fixtureImage(`av${i}`, 70, 70),
				roles: { isPartner: i % 3 === 0 },
			},
			freeformTags: Array.from({ length: tagCount }, (_, t) => ({
				name: [
					'English',
					'Chatting',
					'Speedrun',
					'Retro',
					'Charity',
					'Coding',
					'Piano',
					'Vtuber',
					'DropsEnabled',
				][t % 9],
			})),
			contentClassificationLabels: state === 'edge' && i === 2 ? [{ id: 'MatureGame' }] : [],
		};
	});
	return {
		slug,
		game,
		items,
		returned: state === 'partial' ? count + 21 : count,
		hasMore: state === 'partial',
		...(state === 'partial'
			? {
					_note:
						'The upstream refused to page deeper than this, so this is one page of a longer directory.',
				}
			: {}),
	};
}

/**
 * `GET /api/youtube/search` — a collection whose elements are not all the same.
 *
 * Two renderers are in circulation upstream and only one of them carries a
 * channel name and a duration. A build that reads the first element and assumes
 * the rest match renders "undefined" against half the list, so `populated`
 * holds both variants rather than the convenient one.
 */
export function youtubeSearch(query, state = 'populated') {
	if (state === 'empty') {
		return {
			query,
			videos: [],
			returned: 0,
			indicatedTotal: 0,
			hasMore: false,
			_transport: 'innertube',
		};
	}
	const rand = seeded(53);
	const count = state === 'edge' ? 4 : 14;
	const videos = Array.from({ length: count }, (_, i) => {
		const modern = state === 'edge' ? i % 2 === 1 : i % 3 === 2;
		const base = {
			videoId: `yt-${4000 + i}`,
			title: state === 'edge' && i === 0 ? LONG_TITLE : headline(rand),
			views: `${(rand() * 9 + 0.1).toFixed(1)}M views`,
			published: `${Math.floor(rand() * 11) + 1} months ago`,
			thumbnail: fixtureImage(state === 'edge' && i === 2 ? '__404' : `yt${i}`, 640, 360),
			_renderer: modern ? 'lockupViewModel' : 'videoRenderer',
		};
		// The modern renderer genuinely omits both. Filling them in here would
		// hide the variant the screen has to handle.
		return modern
			? base
			: {
					...base,
					channel: pick(rand, WHO),
					duration: `${Math.floor(rand() * 59) + 1}:0${i % 10}`,
				};
	});
	return {
		query,
		videos,
		returned: count,
		indicatedTotal: state === 'partial' ? 1_240_000 : count,
		hasMore: state === 'partial',
		_transport: 'innertube',
	};
}

// ─── Detail responses, one per screen's after-a-click route ──────────

/**
 * `GET /api/hackernews/item/:id` — a story with its comment tree.
 *
 * `indicatedCommentCount` against `returnedCommentCount` is the pair that makes
 * this route honest, and the two disagree in `partial`: a tree rendered silently
 * is indistinguishable from a discussion that small.
 */
export function hackernewsItem(id, state = 'populated') {
	const rand = seeded(97);
	const story = {
		id,
		rank: null,
		title: headline(rand),
		url: `https://example.org/post/${id}`,
		site: 'example.org',
		points: 412,
		author: pick(rand, WHO),
		ageISO: '2026-07-29T08:00:00.000Z',
		ageText: '6 hours ago',
		commentCount: 37,
		commentsUrl: `item?id=${id}`,
	};
	if (state === 'empty') {
		return {
			story,
			comments: [],
			indicatedCommentCount: 0,
			returnedCommentCount: 0,
			hasMore: false,
		};
	}

	// Nested rather than flat, and deep enough to prove the indent renders: a
	// tree built two levels deep looks correct against a fixture two levels deep.
	const child = (depth, i) => ({
		id: `c-${depth}-${i}`,
		author: state === 'edge' && depth === 1 && i === 0 ? null : pick(rand, WHO),
		ageISO: '2026-07-29T09:00:00.000Z',
		ageText: `${depth + 1} hours ago`,
		indent: depth,
		deleted: state === 'edge' && depth === 0 && i === 1,
		textHTML:
			state === 'edge' && depth === 0 && i === 0
				? `<p>A comment with <a href="https://example.org">a link</a>, <i>emphasis</i> and <code>inline_code()</code> in it, long enough to wrap across several lines so the measure of the text column is visible at every indent level.</p><p>And a second paragraph, because a comment body is arbitrary markup rather than a single line.</p>`
				: `<p>${headline(rand)}.</p>`,
		onStoryTitle: null,
		onStoryUrl: null,
		children: depth < 3 && i === 0 ? [child(depth + 1, 0), child(depth + 1, 1)] : [],
	});
	const comments = [child(0, 0), child(0, 1), child(0, 2)];
	const returnedCommentCount = 9;
	return {
		story,
		comments,
		indicatedCommentCount: state === 'partial' ? 37 : returnedCommentCount,
		returnedCommentCount,
		hasMore: state === 'partial',
	};
}

/** `GET /api/reddit/post/:sub/:id` — a post with a flat, depth-tagged comment list. */
export function redditPost(subreddit, id, state = 'populated') {
	const rand = seeded(101);
	const post = {
		id,
		kind: 'link',
		title: headline(rand),
		permalink: `/r/${subreddit}/comments/${id}/synthetic/`,
		author: pick(rand, WHO),
		subreddit,
		score: 24_800,
		numComments: 1240,
		createdUtc: 1_785_000_000,
		selftext:
			state === 'edge'
				? 'A body long enough to need a measure of its own: several sentences of running prose, so the detail view has to decide how wide a paragraph is allowed to get before it stops being readable.'
				: '',
		url: `https://example.org/post/${id}`,
		isVideo: false,
		hlsUrl: null,
	};
	if (state === 'empty') {
		return { subreddit, post, comments: [], indicatedTotal: 0, returned: 0, hasMore: false };
	}
	const comments = Array.from({ length: state === 'edge' ? 4 : 10 }, (_, i) => ({
		id: `rc-${i}`,
		author: state === 'edge' && i === 1 ? '[deleted]' : pick(rand, WHO),
		body:
			state === 'edge' && i === 0
				? 'A reply long enough to wrap, and to show what the indent does to the measure once a thread is three or four levels deep rather than one.'
				: `${headline(rand)}.`,
		score: state === 'edge' && i === 2 ? 0 : Math.floor(rand() * 3000) - 40,
		depth: [0, 1, 2, 0, 1, 3, 0, 1, 1, 0][i] ?? 0,
		createdUtc: 1_785_000_600 + i * 60,
		moreChildrenCount: null,
	}));
	return {
		subreddit,
		post,
		comments,
		indicatedTotal: state === 'partial' ? 1240 : comments.length,
		returned: comments.length,
		hasMore: state === 'partial',
	};
}

/** `GET /api/twitch/channel/:login/videos` — a channel's past broadcasts. */
export function twitchChannelVideos(login, state = 'populated') {
	if (state === 'empty') return { login, videos: [], returned: 0, hasMore: false };
	const rand = seeded(103);
	const count = state === 'edge' ? 3 : 8;
	const videos = Array.from({ length: count }, (_, i) => ({
		id: `v-${5000 + i}`,
		title: state === 'edge' && i === 0 ? LONG_TITLE : headline(rand),
		lengthSeconds: Math.floor(rand() * 20_000) + 600,
		viewCount: Math.floor(rand() * 400_000),
		publishedAt: '2026-07-2%dT18:00:00.000Z'.replace('%d', String((i % 8) + 1)),
		previewThumbnailURL: fixtureImage(state === 'edge' && i === 1 ? '__404' : `tv${i}`, 640, 360),
	}));
	return {
		login,
		videos,
		returned: state === 'partial' ? count + 30 : count,
		hasMore: state === 'partial',
	};
}

/** `GET /api/youtube/watch/:id/info` — metadata read out of the watch page. */
export function youtubeInfo(videoId, state = 'populated') {
	const rand = seeded(107);
	return {
		videoId,
		title: state === 'edge' ? LONG_TITLE : headline(rand),
		author: pick(rand, WHO),
		channelId: 'UCsynthetic0000000000000',
		lengthSeconds: 3_726,
		viewCount: 58_412_990,
		publishDate: '2026-03-14',
		category: 'Music',
		keywords: state === 'edge' ? [] : ['lofi', 'study', 'beats', 'ambient'],
		shortDescription:
			'A description of several lines, because this field is free text and a detail view has to decide whether to clamp it or let it run.\n\nIt contains a blank line, which is the part a naive renderer collapses.',
		_transport: 'embedded-json',
	};
}

/** `GET /api/yahoofinance/screener/:id` — a ranked table of quotes. */
export function yahooScreener(screenerId, state = 'populated') {
	const title = screenerId
		.toLowerCase()
		.split('_')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
	if (state === 'empty') {
		return { screenerId, title, quotes: [], start: 0, count: 0, returned: 0, hasMore: false };
	}
	const rand = seeded(109);
	const symbols = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'INTC', 'AMZN', 'GOOG', 'META', 'NFLX'];
	const count = state === 'edge' ? 4 : 10;
	const quotes = Array.from({ length: count }, (_, i) => ({
		symbol: symbols[i % symbols.length],
		name: state === 'edge' && i === 0 ? LONG_TITLE : `${symbols[i % symbols.length]} Holdings Inc.`,
		price: Number((rand() * 900 + 8).toFixed(2)),
		// Both signs, and a zero: a table that colours by sign renders one of the
		// three wrong until all three are on screen at once.
		changePercent:
			state === 'edge' ? [0, -12.5, 8.25, -0.01][i] : Number((rand() * 14 - 7).toFixed(2)),
		volume: Math.floor(rand() * 90_000_000),
	}));
	return {
		screenerId,
		title,
		quotes,
		start: 0,
		count,
		returned: count,
		hasMore: state === 'partial',
		...(state === 'partial' ? { indicatedTotal: 248 } : {}),
	};
}

/** `GET /api/yahoofinance/chart/:symbol` — a price series. */
export function yahooChart(symbol, state = 'populated') {
	if (state === 'empty') {
		return { symbol, range: '1mo', interval: '1d', currency: 'USD', candles: [], returned: 0 };
	}
	const rand = seeded(113);
	let close = 180;
	const candles = Array.from({ length: state === 'edge' ? 3 : 30 }, (_, i) => {
		const open = close;
		close = Math.max(1, open * (1 + (rand() - 0.5) * 0.06));
		return {
			time: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T13:30:00.000Z`,
			open: Number(open.toFixed(2)),
			high: Number(Math.max(open, close).toFixed(2)),
			low: Number(Math.min(open, close).toFixed(2)),
			close: Number(close.toFixed(2)),
			volume: Math.floor(rand() * 60_000_000),
		};
	});
	return {
		symbol,
		range: '1mo',
		interval: '1d',
		currency: 'USD',
		candles,
		returned: candles.length,
	};
}

/** `GET /api/boardshop/catalog` — a product grid. */
export function boardshopCatalog(state = 'populated') {
	if (state === 'empty') {
		return {
			query: '',
			items: [],
			page: 1,
			pageSize: 12,
			total: 0,
			returned: 0,
			remaining: 0,
			hasMore: false,
		};
	}
	const rand = seeded(127);
	const cats = ['decks', 'trucks', 'wheels', 'accessories'];
	const count = state === 'edge' ? 4 : 12;
	const items = Array.from({ length: count }, (_, i) => ({
		sku: `${cats[i % 4].slice(0, 4).toUpperCase()}-${String(100 + i)}`,
		name:
			state === 'edge' && i === 0 ? LONG_TITLE : `${pick(rand, WHO)} ${cats[i % 4].slice(0, -1)}`,
		brand: pick(rand, WHO),
		category: cats[i % 4],
		price: Number((rand() * 240 + 12).toFixed(2)),
		currency: 'USD',
		// Zero stock is the case that decides whether a card can be bought, and a
		// catalogue where everything is in stock never shows it.
		stock: state === 'edge' ? [0, 1, 340, 0][i] : Math.floor(rand() * 40),
		rating: Number((rand() * 4 + 1).toFixed(1)),
		reviewCount: state === 'edge' && i === 1 ? 0 : Math.floor(rand() * 800),
		description: 'A synthetic product standing in for one of a catalogue.',
		image: fixtureImage(state === 'edge' && i === 2 ? '__404' : `bs${i}`, 480, 480),
	}));
	return {
		query: '',
		items,
		page: 1,
		pageSize: 12,
		total: state === 'partial' ? 214 : count,
		returned: count,
		remaining: state === 'partial' ? 202 : 0,
		hasMore: state === 'partial',
	};
}

/** `GET /api/boardshop/product/:sku` — one product, with stock per warehouse. */
export function boardshopProduct(sku, state = 'populated') {
	const rand = seeded(131);
	const product = {
		sku,
		name: state === 'edge' ? LONG_TITLE : `${pick(rand, WHO)} deck`,
		brand: pick(rand, WHO),
		category: 'decks',
		price: 129.95,
		currency: 'USD',
		stock: state === 'edge' ? 0 : 18,
		rating: 4.4,
		reviewCount: state === 'edge' ? 0 : 212,
		description:
			'A synthetic product detail body. Long enough to need a measure, short enough to read.',
		image: fixtureImage(`bsd-${sku}`, 640, 640),
	};
	return {
		product,
		relatedSkus: state === 'edge' ? [] : ['DECK-101', 'TRUC-102', 'WHEE-103'],
		warehouses: [
			{ id: 'w1', name: 'Portland', available: state === 'edge' ? 0 : 12 },
			{ id: 'w2', name: 'Rotterdam', available: state === 'edge' ? 0 : 6 },
		],
		lastUpdated: '2026-07-29T17:40:00.000Z',
		reviews:
			state === 'edge'
				? []
				: Array.from({ length: 4 }, (_, i) => ({
						id: `rev-${i}`,
						author: pick(rand, WHO),
						rating: [5, 4, 2, 3][i],
						date: '2026-07-1%d'.replace('%d', String(i + 1)),
						text: `${headline(rand)}. Held up over a season.`,
					})),
	};
}

// ─── Routing ─────────────────────────────────────────────────────────

/**
 * Resolve one request to a status and a body. Pure — no clock, no socket.
 *
 * Returns `{ status, body }`, or `{ status, delayMs }` for the in-flight state,
 * or null when nothing here serves that path. Null is answered with a 404 that
 * names the path, because a fixture silently returning an empty body is the one
 * failure mode that looks exactly like a screen with nothing to show.
 */
export function resolve(pathname, search) {
	const q = new URLSearchParams(search);

	const hn = pathname.match(/^\/api\/hackernews\/list\/([^/]+)$/);
	if (hn) return dispatch(stateOf(decodeURIComponent(hn[1])), (s) => hackernewsList(hn[1], s));

	// Detail routes take their state from the identifier too, so a detail view can
	// be looked at empty, refused and in flight without touching its list.
	const hnItem = pathname.match(/^\/api\/hackernews\/item\/([^/]+)$/);
	if (hnItem) {
		const id = decodeURIComponent(hnItem[1]);
		return dispatch(stateOf(id), (s) => hackernewsItem(id, s));
	}

	const rdPost = pathname.match(/^\/api\/reddit\/post\/([^/]+)\/([^/]+)$/);
	if (rdPost) {
		const [sub, id] = [decodeURIComponent(rdPost[1]), decodeURIComponent(rdPost[2])];
		return dispatch(stateOf(id), (s) => redditPost(sub, id, s));
	}

	const twVideos = pathname.match(/^\/api\/twitch\/channel\/([^/]+)\/videos$/);
	if (twVideos) {
		const login = decodeURIComponent(twVideos[1]);
		return dispatch(stateOf(login), (s) => twitchChannelVideos(login, s));
	}

	const ytInfo = pathname.match(/^\/api\/youtube\/watch\/([^/]+)\/info$/);
	if (ytInfo) {
		const id = decodeURIComponent(ytInfo[1]);
		return dispatch(stateOf(id), (s) => youtubeInfo(id, s));
	}

	const yfScreener = pathname.match(/^\/api\/yahoofinance\/screener\/([^/]+)$/);
	if (yfScreener) {
		const id = decodeURIComponent(yfScreener[1]);
		return dispatch(stateOf(id), (s) => yahooScreener(id, s));
	}

	const yfChart = pathname.match(/^\/api\/yahoofinance\/chart\/([^/]+)$/);
	if (yfChart) {
		const symbol = decodeURIComponent(yfChart[1]);
		return dispatch(stateOf(symbol), (s) => yahooChart(symbol, s));
	}

	if (pathname === '/api/boardshop/catalog') {
		return dispatch(stateOf(q.get('q') ?? ''), (s) => boardshopCatalog(s));
	}

	const bsProduct = pathname.match(/^\/api\/boardshop\/product\/([^/]+)$/);
	if (bsProduct) {
		const sku = decodeURIComponent(bsProduct[1]);
		return dispatch(stateOf(sku), (s) => boardshopProduct(sku, s));
	}

	const sub = pathname.match(/^\/api\/reddit\/r\/([^/]+)$/);
	if (sub) {
		const name = decodeURIComponent(sub[1]);
		return dispatch(stateOf(name), (s) => redditFeed(name, s));
	}
	if (pathname === '/api/reddit/popular') return dispatch('populated', (s) => redditFeed('', s));

	const tw = pathname.match(/^\/api\/twitch\/directory\/([^/]+)\/streams$/);
	if (tw) {
		const slug = decodeURIComponent(tw[1]);
		return dispatch(stateOf(slug), (s) => twitchCategory(slug, s));
	}

	if (pathname === '/api/youtube/search') {
		const query = q.get('q') ?? '';
		if (!query) return { status: 400, body: { error: 'q is required' } };
		return dispatch(stateOf(query), (s) => youtubeSearch(query, s));
	}
	if (pathname === '/api/youtube/suggest') {
		const query = q.get('q') ?? '';
		if (!query) return { status: 400, body: { error: 'q is required' } };
		const rand = seeded(71);
		const suggestions = Array.from({ length: 8 }, () => `${query} ${pick(rand, NOUN)}`);
		return {
			status: 200,
			body: { query, suggestions, returned: suggestions.length, _transport: 'jsonp' },
		};
	}

	return null;
}

/** Turn a resolved state into the response that state means. Pure. */
function dispatch(state, build) {
	if (state === 'error') {
		return {
			status: 502,
			body: { error: 'The upstream refused this request.', _fixture: true },
		};
	}
	// Longer than any capture settle delay, so the shot lands mid-flight.
	if (state === 'slow') return { status: 200, delayMs: 120_000 };
	return { status: 200, body: build(state) };
}

/**
 * A picture, as SVG so it needs no encoder.
 *
 * Returns null for the seed that refuses — the card-with-no-picture path is a
 * state, and it is the one that reflows a grid.
 */
export function svgFor(seed, w, h) {
	if (seed === '__404') return null;
	const rand = seeded([...seed].reduce((a, c) => a + c.charCodeAt(0), 7));
	const hue = Math.floor(rand() * 360);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue} 55% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 48) % 360} 52% 34%)"/>
</linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<text x="50%" y="52%" text-anchor="middle" font-family="sans-serif" font-size="${Math.max(10, Math.round(Math.min(w, h) / 7))}" fill="rgba(255,255,255,.82)">${w}×${h}</text>
</svg>`;
}

// ─── Server ──────────────────────────────────────────────────────────

function usage() {
	console.log(`
fixture-api — serve the domain routes' declared shapes locally.

  node scripts/fixture-api.mjs [--port=3101] [--max-requests=2000] [--wall-clock=1800]

Then point the web app at it:
  API_PORT=3101 pnpm --filter @interceptor/web dev

States, selected through each screen's own identifier:
${STATES.map((s) => `  __${s}`).join('\n')}
`);
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		usage();
		return;
	}

	let served = 0;
	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost');

		const img = url.pathname === '/api/__fixture/img';
		if (!img && ++served > opts.maxRequests) {
			// Saying so beats answering forever: a silent cap reads as the route
			// having nothing to return.
			res.writeHead(429, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: `fixture-api request cap reached (${opts.maxRequests})` }));
			return;
		}

		if (img) {
			const seed = url.searchParams.get('seed') ?? 'x';
			const w = Math.min(Number(url.searchParams.get('w') ?? 640) || 640, 2000);
			const h = Math.min(Number(url.searchParams.get('h') ?? 360) || 360, 2000);
			const svg = svgFor(seed, w, h);
			if (!svg) {
				res.writeHead(404, { 'content-type': 'text/plain' });
				res.end('no such picture');
				return;
			}
			res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
			res.end(svg);
			return;
		}

		const hit = resolve(url.pathname, url.search);
		if (!hit) {
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: `fixture-api serves no ${url.pathname}` }));
			console.log(`  404 ${url.pathname}`);
			return;
		}

		const send = () => {
			res.writeHead(hit.status, {
				'content-type': 'application/json',
				'cache-control': 'no-store',
			});
			res.end(JSON.stringify(hit.body ?? {}));
		};
		console.log(`  ${hit.status}${hit.delayMs ? ' (holding)' : ''} ${url.pathname}${url.search}`);
		if (hit.delayMs) {
			const timer = setTimeout(send, hit.delayMs);
			req.on('close', () => clearTimeout(timer));
			return;
		}
		send();
	});

	server.listen(opts.port, () => {
		console.log(`fixture-api on http://localhost:${opts.port} — no outbound requests`);
		console.log(`  API_PORT=${opts.port} pnpm --filter @interceptor/web dev`);
	});

	// A bound port outliving its run is exactly the mess an unattended loop
	// leaves behind, so the ceiling is enforced here rather than trusted to a
	// caller remembering to stop the process.
	setTimeout(() => {
		console.log(`fixture-api reached its ${opts.wallClock / 1000}s ceiling; closing`);
		server.close();
		process.exit(0);
	}, opts.wallClock).unref?.();
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
