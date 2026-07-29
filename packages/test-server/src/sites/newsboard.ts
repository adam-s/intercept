/**
 * Newsboard — the transports a 2026 front end reaches for.
 *
 * The other fixture sites cover the shapes an API-first site uses: JSON over
 * XHR, GraphQL, a socket, an encoded payload. Live runs against real sites kept
 * turning up a second family that none of them served, so agents were asked to
 * verdict rows they had never seen demonstrated:
 *
 *  - Data server-rendered into HTML *attributes* rather than into a JSON blob.
 *    A custom element carrying its own record is not embedded JSON and not an
 *    API response, and a scan looking for either reports the page as dataless
 *    while every field sits in the markup.
 *  - Long-poll. A request that hangs until there is something to say looks
 *    exactly like a slow GET, so "no WebSocket" gets recorded as "no realtime"
 *    and the actual stream goes unnoticed.
 *  - SSE, which is a plain GET at the wire and only distinguishable by the
 *    primitive the page reached for.
 *  - Work done somewhere the page's own scope cannot see: a worker with its own
 *    globals, a service worker answering from cache, an iframe doing the
 *    fetching and replying over postMessage.
 *  - Egress that carries data out rather than fetching it in — beacons and
 *    pixels — which belong in a coverage count as explained, not as a gap.
 *
 * Every route here exists to be discovered. Nothing is hidden behind auth,
 * because the point is to teach what the transport looks like, not to test
 * whether it can be reached.
 *
 * @module test-server/sites/newsboard
 */

import { Hono } from 'hono';

interface Story {
	id: number;
	title: string;
	author: string;
	points: number;
	comments: number;
}

const STORIES: Story[] = [
	{ id: 101, title: 'Deck shortage eases', author: 'ana', points: 142, comments: 38 },
	{ id: 102, title: 'Trucks recalled', author: 'bo', points: 97, comments: 21 },
	{ id: 103, title: 'Wheel durometer guide', author: 'cy', points: 61, comments: 12 },
];

/**
 * The record lives in the attributes, not in a script tag. This is the shape
 * that reads as "no embedded data" to a scan looking for a JSON blob, and it is
 * how a real front end using custom elements ships its first paint.
 */
function storyElement(s: Story): string {
	return (
		`<news-story story-id="${s.id}" author="${s.author}" points="${s.points}" ` +
		`comment-count="${s.comments}" data-title="${s.title}">` +
		`<h2>${s.title}</h2><span>${s.points} points by ${s.author}</span>` +
		`</news-story>`
	);
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8"><title>newsboard</title>

<!-- Semantic markup: standards rather than framework internals, so a reader can
     extract this without knowing what built the page. Search engines ask for it,
     which is why a page with no hydration payload still routinely carries the
     record you want. -->
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"ItemList","numberOfItems":3,
 "itemListElement":[
  {"@type":"NewsArticle","position":1,"headline":"Deck shortage eases","author":{"@type":"Person","name":"ana"},"interactionStatistic":{"@type":"InteractionCounter","userInteractionCount":142}},
  {"@type":"NewsArticle","position":2,"headline":"Trucks recalled","author":{"@type":"Person","name":"bo"},"interactionStatistic":{"@type":"InteractionCounter","userInteractionCount":97}},
  {"@type":"NewsArticle","position":3,"headline":"Wheel durometer guide","author":{"@type":"Person","name":"cy"},"interactionStatistic":{"@type":"InteractionCounter","userInteractionCount":61}}]}
</script>
<meta property="og:title" content="Newsboard — front page">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
</head>
<body>
<main id="feed">
${STORIES.map(storyElement).join('\n')}
</main>

<!-- HTML-over-the-wire: the response body is markup, appended as-is. -->
<button id="more" hx-get="/sites/newsboard/fragment/stories?page=2" hx-target="#feed" hx-swap="beforeend">
	Load more
</button>

<!-- Nothing below fires on load. These exist so a capture taken from a merely
     loaded page can be compared against one taken after the page was exercised. -->
<input id="q" type="search" placeholder="Search stories" autocomplete="off">
<button id="chat" aria-expanded="false" aria-controls="chatpanel">Show chat</button>
<div id="chatpanel" hidden></div>
<div id="sentinel" style="height:1400px"></div>

<!-- Cross-frame RPC: the frame does the fetching and answers over postMessage. -->
<iframe id="widget" src="/sites/newsboard/widget" style="width:0;height:0;border:0"></iframe>

<script>
const attempt = (name, fn) => { try { fn(); } catch (e) { console.warn(name, String(e)); } };

// SSE — a plain GET at the wire, an EventSource to the page.
attempt('sse', () => new EventSource('/sites/newsboard/live/points'));

// Long-poll — resolves when there is news, then immediately asks again. Two
// requests deep is enough for the period to be visible in a capture.
attempt('longpoll', () => {
	let rounds = 0;
	const poll = () => {
		if (rounds++ > 3) return;
		fetch('/sites/newsboard/poll/updates?since=' + Date.now()).then(poll).catch(() => {});
	};
	poll();
});

// Streamed body: read as it arrives rather than awaited whole.
attempt('stream', () => {
	fetch('/sites/newsboard/stream/stories').then((r) => {
		const reader = r.body.getReader();
		const pump = () => reader.read().then(({ done }) => { if (!done) pump(); });
		pump();
	});
});

// A worker has its own global scope; nothing patched in the page sees its fetch.
attempt('worker', () => new Worker('/sites/newsboard/worker.js'));
attempt('serviceworker', () => navigator.serviceWorker.register('/sites/newsboard/sw.js'));

// Egress that carries data out rather than fetching it in.
attempt('beacon', () => navigator.sendBeacon('/sites/newsboard/collect', 'view=feed'));
attempt('pixel', () => { new Image().src = '/sites/newsboard/px.gif?ev=load'; });

// Constructed, not connected: no signalling server and no HTTP/3 here. The
// elimination row asks what the page reached for, and the attempt answers it.
attempt('webrtc', () => new RTCPeerConnection().createDataChannel('live'));
attempt('webtransport', () => new WebTransport('https://localhost:1/wt'));

attempt('broadcast', () => new BroadcastChannel('newsboard').postMessage({ ready: true }));

// ─── Interaction-gated. None of this runs unless the page is exercised. ───

// Typeahead: fires on the first keystroke and never before.
attempt('typeahead', () => {
	document.getElementById('q').addEventListener('input', (e) => {
		fetch('/sites/newsboard/suggest?q=' + encodeURIComponent(e.target.value));
	});
});

// A chat socket that only opens when its panel is mounted — the shape that made
// a real site's three sockets read as one.
attempt('chat', () => {
	document.getElementById('chat').addEventListener('click', () => {
		try {
			new WebSocket(location.origin.replace('http', 'ws') + '/sites/newsboard/chat');
		} catch (e) { console.warn('chat', String(e)); }
	});
});

// Infinite scroll: a page fetch at the scroll boundary.
attempt('scroll', () => {
	let page = 1;
	window.addEventListener('scroll', () => {
		if (window.scrollY + window.innerHeight < document.body.scrollHeight - 200) return;
		fetch('/sites/newsboard/page/' + ++page);
	}, { passive: true });
});
window.addEventListener('message', (e) => { if (e.data?.widget) console.log('widget said', e.data); });
</script>
</body>
</html>`;

/** The frame that fetches on the host page's behalf and replies over postMessage. */
const WIDGET = `<!doctype html>
<html><body>
<script>
fetch('/sites/newsboard/api/trending')
	.then((r) => r.json())
	.then((d) => parent.postMessage({ widget: 'trending', data: d }, '*'))
	.catch(() => {});
</script>
</body></html>`;

export function createNewsboardSite(): Hono {
	const app = new Hono();

	app.get('/', (c) => c.html(PAGE));

	/**
	 * The same records with no framework payload and no custom elements — only
	 * standards. This is the page that answers "the site has no embedded data"
	 * with "you were looking for the wrong shape".
	 */
	app.get('/semantic', (c) =>
		c.html(`<!doctype html><html><head><meta charset="utf-8">
<script type="application/ld+json">${JSON.stringify({
			'@context': 'https://schema.org',
			'@type': 'ItemList',
			numberOfItems: STORIES.length,
			itemListElement: STORIES.map((s, i) => ({
				'@type': 'NewsArticle',
				position: i + 1,
				headline: s.title,
				author: { '@type': 'Person', name: s.author },
				interactionStatistic: {
					'@type': 'InteractionCounter',
					userInteractionCount: s.points,
				},
			})),
		})}</script>
<meta property="og:title" content="Newsboard"><meta property="og:site_name" content="newsboard">
</head><body><p>Nothing here but standards.</p></body></html>`),
	);
	app.get('/widget', (c) => c.html(WIDGET));

	// Data in attributes — the same records the page ships, addressable directly.
	app.get('/stories', (c) => c.html(STORIES.map(storyElement).join('\n')));

	/**
	 * HTML-over-the-wire: a markup fragment, not JSON. The body is meant to be
	 * inserted into the DOM as-is, which is why a JSON-shaped scan finds nothing
	 * and reports the endpoint as a page rather than as data.
	 */
	app.get('/fragment/stories', (c) => {
		const page = Number(c.req.query('page') ?? '1');
		const extra: Story = {
			id: 200 + page,
			title: `Page ${page} story`,
			author: 'dee',
			points: 30 + page,
			comments: page,
		};
		return c.html(storyElement(extra), 200, { 'content-type': 'text/html; charset=utf-8' });
	});

	/** SSE. Distinguishable from a slow GET only by the primitive the page used. */
	app.get('/live/points', (c) =>
		c.body(
			STORIES.map((s) => `event: points\ndata: {"id":${s.id},"points":${s.points + 1}}\n\n`).join(
				'',
			),
			200,
			{
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'keep-alive',
			},
		),
	);

	/**
	 * Long-poll. A real one holds the connection open; this answers immediately
	 * so the fixture stays fast, and declares the shape in the payload so a
	 * reader can tell what it is standing in for.
	 */
	app.get('/poll/updates', async (c) => {
		// Holds before answering, because that is what a long-poll does and a
		// fixture that answers instantly does not demonstrate the transport it
		// claims to. Without the hold the requests arrive as a burst, which is
		// pagination's shape rather than a cadence — and the detector is right to
		// refuse it. Short enough to keep the fixture fast.
		await new Promise((r) => setTimeout(r, 700));
		return c.json({
			transport: 'long-poll',
			since: c.req.query('since') ?? null,
			updates: [{ id: 101, points: 143 }],
			reconnect: true,
		});
	});

	app.get('/api/trending', (c) => c.json({ trending: STORIES.slice(0, 2), total: 2 }));

	/**
	 * A response meant to be read as it arrives, not waited for. NDJSON over a
	 * plain GET: at the wire this is an ordinary request, and only the way the
	 * caller consumes it makes it a stream — which is why a capture that records
	 * request starts files a live feed as a slow endpoint.
	 */
	app.get('/stream/stories', (c) =>
		c.body(`${STORIES.map((s) => JSON.stringify(s)).join('\n')}\n`, 200, {
			'content-type': 'application/x-ndjson',
			'cache-control': 'no-cache',
		}),
	);

	// Its own scope, its own fetch — invisible to anything patched in the page.
	app.get('/worker.js', (c) =>
		c.body(
			"fetch('/sites/newsboard/api/trending').then((r) => r.json()).then((d) => postMessage(d));",
			200,
			{ 'content-type': 'application/javascript' },
		),
	);
	app.get('/sw.js', (c) =>
		c.body("self.addEventListener('fetch', () => {});", 200, {
			'content-type': 'application/javascript',
		}),
	);

	// ─── Interaction-gated endpoints ─────────────────────────────────────
	// Reachable directly, but never requested unless the page is exercised.
	app.get('/suggest', (c) =>
		c.json({ query: c.req.query('q') ?? '', suggestions: STORIES.map((s) => s.title).slice(0, 2) }),
	);
	app.get('/page/:n', (c) =>
		c.json({ page: Number(c.req.param('n')), stories: STORIES.slice(0, 1), total: 3 }),
	);

	app.post('/collect', (c) => c.body(null, 204));
	app.get('/px.gif', (c) => c.body(null, 204));

	return app;
}
