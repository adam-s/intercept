/**
 * The reference material must demonstrate every transport the protocol asks
 * about.
 *
 * Discovery hands an agent a table of transport rows and asks for a verdict on
 * each. That is only answerable if the agent knows what the transport looks
 * like when present — what fires, what the payload looks like, how a route
 * consumes it. The reference domain and the test server are where that gets
 * learned, and AGENTS.md says as much: reading them beats inventing a shape.
 *
 * So a row the table asks about, with no fixture to observe and no example to
 * copy, is a question posed without the material needed to answer it. That is
 * not hypothetical. SSE was a row in the table for the whole of this project's
 * life; the test server served no `text/event-stream` anywhere and no route
 * consumed one. Agents were asked to verdict a transport they had never seen
 * here, and the docblock claiming the fixture existed made it worse than
 * silence.
 *
 * These tests hold the correspondence in both directions: every canonical
 * transport is demonstrated, and every demonstration names a canonical
 * transport. Adding a row to the table without adding material fails here.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ROUTES = readFileSync(resolve(ROOT, 'domains/boardshop/src/routes.ts'), 'utf8');

const { TRANSPORT_SIGNATURES } = await import('../discover-probe.mjs');

/** Every row the elimination table asks a verdict on. */
const CANONICAL = Object.keys(TRANSPORT_SIGNATURES).sort();

/** What the reference domain claims to demonstrate, read back off its routes. */
const DEMONSTRATED = [...ROUTES.matchAll(/^\t\ttransport: '([^']+)',$/gm)].map((m) => m[1]);

describe('the reference domain demonstrates every transport the table asks about', () => {
	it('reads a non-empty canonical list, so this cannot pass vacuously', () => {
		expect(CANONICAL.length).toBeGreaterThanOrEqual(10);
	});

	it('reads declarations back off the reference, so this cannot pass vacuously', () => {
		expect(DEMONSTRATED.length).toBeGreaterThan(0);
	});

	it.each(CANONICAL)('demonstrates %s in at least one route', (transport) => {
		expect(DEMONSTRATED).toContain(transport);
	});

	// A typo here would silently satisfy nothing while looking like coverage.
	it('declares no transport the table has never heard of', () => {
		const unknown = [...new Set(DEMONSTRATED)].filter((t) => !CANONICAL.includes(t)).sort();
		expect(unknown).toEqual([]);
	});
});

describe('the test server carries a fixture for every transport', () => {
	const SERVER = ['boardshop', 'liveboard', 'streamshop', 'databoard', 'newsboard', 'benchmark']
		.map((s) => {
			try {
				return readFileSync(resolve(ROOT, `packages/test-server/src/sites/${s}.ts`), 'utf8');
			} catch {
				return '';
			}
		})
		.join('\n');
	const TRANSPORTS = ['embedded-html', 'encoded', 'graphql', 'hls', 'protobuf', 'websocket']
		.map((t) => readFileSync(resolve(ROOT, `packages/test-server/src/transports/${t}.ts`), 'utf8'))
		.join('\n');
	const ALL = `${SERVER}\n${TRANSPORTS}`;

	/**
	 * The observable evidence each transport leaves in a fixture's source. A
	 * fixture serves the transport; this is how a test with no browser can tell
	 * that it does.
	 */
	const FIXTURE_MARKERS = {
		'Embedded JSON': /__NEXT_DATA__|__NUXT|__PRELOADED_STATE__|application\/json/,
		'JSON API (XHR)': /c\.json\(/,
		'HTML-over-the-wire': /hx-|turbo-stream|text\/vnd/,
		GraphQL: /graphql|\/gql/i,
		WebSocket: /WebSocketServer|handleWSUpgrade|new WebSocket\(/,
		WebTransport: /WebTransport/,
		WebRTC: /RTCPeerConnection/,
		'HLS/Media': /m3u8|application\/vnd\.apple\.mpegurl/i,
		'gRPC-Web': /grpcWebFrame|application\/grpc-web/,
		SSE: /text\/event-stream/,
		'Encoded/Binary': /msgpack|protobuf|base64/i,
		JSONP: /callback=|\bjsonp\b/i,
		'Worker-scoped': /new Worker\(|importScripts/,
		'Service Worker': /serviceWorker\.register|sw\.js/,
		'Cross-frame RPC': /postMessage|BroadcastChannel/,
		'Beacon/Telemetry': /sendBeacon/,
		'Form-encoded POST': /x-www-form-urlencoded|FormData/,
	};

	it('has a marker defined for every canonical transport', () => {
		const missing = CANONICAL.filter((t) => !FIXTURE_MARKERS[t]);
		expect(missing).toEqual([]);
	});

	it.each(CANONICAL)('serves something that exercises %s', (transport) => {
		expect(ALL).toMatch(FIXTURE_MARKERS[transport]);
	});
});

describe('a transport claimed in a docblock is really served', () => {
	// The failure this exists for: the test server's own header claimed liveboard
	// served SSE. It served three JSON routes. An agent reading that believed the
	// fixture existed, which is worse than the header saying nothing at all.
	const SITES = ['boardshop', 'liveboard', 'streamshop', 'databoard'];

	it.each(SITES)('%s serves the SSE its own file claims, or claims none', (site) => {
		const src = readFileSync(resolve(ROOT, `packages/test-server/src/sites/${site}.ts`), 'utf8');
		const header = src.slice(0, src.indexOf('*/') + 2);
		if (/\bSSE\b|event-stream/i.test(header)) {
			expect(src).toMatch(/text\/event-stream/);
		}
	});

	it('the server index does not claim a transport the named site lacks', () => {
		const index = readFileSync(resolve(ROOT, 'packages/test-server/src/index.ts'), 'utf8');
		const header = index.slice(0, index.indexOf('*/') + 2);
		for (const line of header.split('\n')) {
			const m = line.match(/\/sites\/(\w+)\/\s+—\s+(.+)$/);
			if (!m) continue;
			const [, site, claims] = m;
			if (!/\bSSE\b/i.test(claims)) continue;
			const src = readFileSync(resolve(ROOT, `packages/test-server/src/sites/${site}.ts`), 'utf8');
			expect(src, `index claims ${site} serves SSE`).toMatch(/text\/event-stream/);
		}
	});
});

describe('the answer keys stay out of the exam paper', () => {
	// Naming the expected finding in front of the thing being measured destroys
	// the measurement — the whole value of a discovery run is that it was
	// independent. Instructions, rules, prompts and agent definitions are what an
	// agent reads, so none of them may point at the keys.
	const READ_BY_AGENTS = ['AGENTS.md', 'CLAUDE.md', '.agents', 'prompts'];

	const walk = (rel) => {
		const abs = resolve(ROOT, rel);
		let entries = [];
		try {
			entries = readdirSync(abs, { withFileTypes: true });
		} catch {
			return [];
		}
		return entries.flatMap((e) =>
			e.isDirectory()
				? walk(`${rel}/${e.name}`)
				: e.name.endsWith('.md')
					? [`${rel}/${e.name}`]
					: [],
		);
	};

	const files = READ_BY_AGENTS.flatMap((p) => (p.endsWith('.md') ? [p] : walk(p))).filter(Boolean);

	it('finds the files agents read, so this cannot pass vacuously', () => {
		expect(files.length).toBeGreaterThan(5);
	});

	it.each(files)('%s does not point at the keys', (file) => {
		let src = '';
		try {
			src = readFileSync(resolve(ROOT, file), 'utf8');
		} catch {
			return;
		}
		expect(src).not.toContain('data/answer-keys');
	});

	// A key that names no source is an assertion, and an undated one is a fact
	// claim about a moving target.
	it('every key cites sources and a date', () => {
		for (const f of readdirSync(resolve(ROOT, 'data/answer-keys'))) {
			if (!f.endsWith('.json')) continue;
			const key = JSON.parse(readFileSync(resolve(ROOT, 'data/answer-keys', f), 'utf8'));
			expect(key.asOf, `${f} has no asOf`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(key.sources?.length, `${f} cites no sources`).toBeGreaterThan(0);
		}
	});

	// A key declaring a row observable that the classifier cannot emit makes that
	// row a guaranteed miss, and a key declaring a row scan-only that the
	// classifier can emit quietly drops it from the denominator. Both make the
	// score lie, in opposite directions, so the declaration is checked against
	// what the classifier actually produces rather than trusted.
	it('every key declares detectability the classifier agrees with', async () => {
		const { OBSERVABLE_TRANSPORTS } = await import('../../packages/browser/src/driver/manifest.ts');
		for (const f of readdirSync(resolve(ROOT, 'data/answer-keys'))) {
			if (!f.endsWith('.json')) continue;
			const key = JSON.parse(readFileSync(resolve(ROOT, 'data/answer-keys', f), 'utf8'));
			for (const t of key.transports ?? []) {
				const declared = t.detectableBy ?? 'observation';
				const observable = OBSERVABLE_TRANSPORTS.includes(t.transport);
				expect(
					declared,
					`${f}: ${t.transport} is declared ${declared} but the classifier ${observable ? 'can' : 'cannot'} emit it`,
				).toBe(observable ? 'observation' : 'scan');
			}
		}
	});

	// A key naming a transport the table cannot express would score against a row
	// that does not exist.
	it('every key names transports the elimination table knows', () => {
		for (const f of readdirSync(resolve(ROOT, 'data/answer-keys'))) {
			if (!f.endsWith('.json')) continue;
			const key = JSON.parse(readFileSync(resolve(ROOT, 'data/answer-keys', f), 'utf8'));
			for (const t of key.transports ?? []) {
				expect(CANONICAL, `${f} names unknown transport ${t.transport}`).toContain(t.transport);
			}
		}
	});
});
