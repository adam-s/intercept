/**
 * Benchmark — a page that reaches for every egress primitive we claim to see.
 *
 * The capture layer's claim is coverage: patch the browser's egress primitives
 * and any transport a page uses produces an event. Unit tests check that claim
 * against a fake global, which proves the patches are wired but says nothing
 * about whether they survive a real engine — whether an init script actually
 * lands before page scripts, whether the main-world bridge reaches the world
 * that matters, whether a constructor wrapper breaks a real `WebSocket`.
 *
 * This page is the bench for that. It exercises each primitive once, on load,
 * with no interaction required, and it declares what it exercised. Recall is
 * then a measurement rather than a claim: run the capture against it and count
 * how many declared transports came back.
 *
 * This site is a measuring instrument, not a discovery target. The answer key
 * below is deliberately visible here, which is exactly why nothing that scores
 * an agent's own discovery may ever be written this way — see AGENTS.md on
 * keeping the answer out of the exam paper. A fixture calibrating a tool and an
 * artifact scoring a judgment are opposite cases.
 *
 * @module test-server/sites/benchmark
 */

import { Hono } from 'hono';

/**
 * What this page provably emits, by the transport names the elimination table
 * uses. A row here is a promise the page below keeps; a unit test pins the two
 * together so the key cannot drift from the fixture.
 */
export const BENCHMARK_TRANSPORTS = [
	'Beacon/Telemetry',
	'Cross-frame RPC',
	'Form-encoded POST',
	'GraphQL',
	'HLS/Media',
	'JSON API (XHR)',
	'JSONP',
	'SSE',
	'Service Worker',
	'WebRTC',
	'WebSocket',
	'WebTransport',
	'Worker-scoped',
] as const;

/**
 * The primitive each declared transport is reached through, as a source
 * fragment that must appear in the page. This is what lets a no-browser test
 * catch a fixture that stopped exercising something it still claims.
 */
export const BENCHMARK_PRIMITIVES: Record<(typeof BENCHMARK_TRANSPORTS)[number], string> = {
	'JSON API (XHR)': 'new XMLHttpRequest(',
	// Matches the source that builds the body, not the encoded body — the page
	// serializes at runtime, so `"query"` never appears in the served HTML.
	GraphQL: 'JSON.stringify({ query:',
	WebSocket: 'new WebSocket(',
	SSE: 'new EventSource(',
	'Beacon/Telemetry': 'navigator.sendBeacon(',
	WebRTC: 'new RTCPeerConnection(',
	WebTransport: 'new WebTransport(',
	'Worker-scoped': 'new Worker(',
	'Service Worker': 'navigator.serviceWorker.register(',
	JSONP: 'callback=',
	'HLS/Media': 'appendBuffer(',
	'Form-encoded POST': '.submit()',
	'Cross-frame RPC': 'new BroadcastChannel(',
};

/**
 * Every call is individually guarded. An engine without `WebTransport`, or a
 * refused service-worker registration, must not stop the calls after it — a
 * fixture that halts halfway would report a capture gap that is really a
 * fixture bug, and that is the one failure this bench cannot afford.
 */
const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>capture benchmark</title></head>
<body>
<h1>Capture Benchmark</h1>
<p>Exercises one call per egress primitive on load.</p>
<iframe name="sink" id="sink" style="width:0;height:0;border:0"></iframe>
<form id="f" method="POST" action="./form" target="sink">
	<input type="hidden" name="vote" value="up">
</form>
<video id="v" muted></video>
<script>
(() => {
	const attempt = (name, fn) => { try { fn(); } catch (e) { console.warn(name, String(e)); } };

	attempt('fetch', () => fetch('./api/items?page=1'));

	attempt('xhr', () => {
		const x = new XMLHttpRequest();
		x.open('GET', './api/detail/42');
		x.send();
	});

	attempt('graphql', () => fetch('./graphql', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query: '{ items { id name } }' }),
	}));

	attempt('websocket', () => {
		const ws = new WebSocket(location.origin.replace('http', 'ws') + '/sites/benchmark/ws');
		ws.addEventListener('open', () => ws.send('hello'));
	});

	attempt('sse', () => new EventSource('./events'));

	attempt('beacon', () => navigator.sendBeacon('./collect', 'event=load'));

	attempt('pixel', () => { new Image().src = './px.gif?uid=7'; });

	attempt('webrtc', () => {
		const pc = new RTCPeerConnection();
		pc.createDataChannel('bench');
	});

	// No HTTP/3 here, so construction rejects. Recording the attempt is the
	// point: the elimination row is about what the page reached for.
	attempt('webtransport', () => new WebTransport('https://localhost:1/wt'));

	attempt('worker', () => new Worker('./worker.js'));

	attempt('serviceworker', () => navigator.serviceWorker.register('./sw.js'));

	attempt('jsonp', () => {
		const s = document.createElement('script');
		s.src = './jsonp?callback=onBench';
		document.head.appendChild(s);
	});

	attempt('mse', () => {
		const ms = new MediaSource();
		document.getElementById('v').src = URL.createObjectURL(ms);
		ms.addEventListener('sourceopen', () => {
			try {
				const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
				sb.appendBuffer(new Uint8Array(8));
			} catch (e) { console.warn('mse-append', String(e)); }
		});
	});

	attempt('postmessage', () => window.postMessage({ bench: true }, '*'));
	attempt('broadcast', () => new BroadcastChannel('bench').postMessage({ tick: 1 }));

	// Targets the hidden iframe, so the page under measurement stays put.
	attempt('form', () => document.getElementById('f').submit());
})();
</script>
</body>
</html>`;

/** The benchmark site. Endpoints exist so each call gets a real response. */
export function createBenchmarkSite(): Hono {
	const app = new Hono();

	app.get('/', (c) => c.html(PAGE));

	app.get('/api/items', (c) =>
		c.json({ items: [{ id: 1, name: 'deck' }], page: 1, total: 2, hasMore: true }),
	);
	app.get('/api/detail/:id', (c) => c.json({ id: c.req.param('id'), name: 'deck', price: 89 }));
	app.post('/graphql', (c) => c.json({ data: { items: [{ id: '1', name: 'deck' }] } }));

	app.get('/events', (c) =>
		c.body('data: {"tick":1}\n\ndata: {"tick":2}\n\n', 200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
		}),
	);

	app.post('/collect', (c) => c.body(null, 204));
	app.get('/px.gif', (c) => c.body(null, 204));
	app.get('/jsonp', (c) =>
		c.body('onBench({"ok":true})', 200, { 'content-type': 'application/javascript' }),
	);

	// A worker with its own scope, so its fetch is invisible to a page-only patch
	// — the case the Worker-scoped row exists to flag.
	app.get('/worker.js', (c) =>
		c.body("fetch('./api/items?from=worker');", 200, {
			'content-type': 'application/javascript',
		}),
	);
	app.get('/sw.js', (c) =>
		c.body("self.addEventListener('fetch', () => {});", 200, {
			'content-type': 'application/javascript',
		}),
	);

	app.post('/form', (c) => c.html('<!doctype html><p>ok</p>'));

	return app;
}
