/**
 * Pins for the reduction that makes capture affordable, and for the derived
 * elimination table that replaces a model's recollection with observation.
 *
 * The reduction has two failure directions and both are silent, so both are
 * pinned: over-templating merges distinct endpoints into one row (a lost
 * transport), under-templating explodes one endpoint into hundreds (the cost
 * this exists to remove).
 */

import { describe, expect, it } from 'vitest';
import type { EgressEvent } from '../instrument.js';
import {
	buildManifest,
	deriveTransports,
	detectChallengePresence,
	MANIFEST_LIMITS,
	parseTarget,
	renderTransports,
	shapeOfBody,
	templateSegment,
} from '../manifest.js';

const ev = (over: Partial<EgressEvent>): EgressEvent => ({
	kind: 'fetch',
	method: 'GET',
	url: 'https://x.test/a',
	t: 0,
	...over,
});

describe('templateSegment', () => {
	it.each([
		['12345', '{id}'],
		['550e8400-e29b-41d4-a716-446655440000', '{uuid}'],
		['a1b2c3d4e5f6a7b8', '{hash}'],
		['dQw4w9WgXcQ01', '{id}'],
	])('replaces the volatile segment %s', (input, expected) => {
		expect(templateSegment(input)).toBe(expected);
	});

	// Over-templating is the dangerous direction: merge `/search` into `/{id}`
	// and an entire endpoint disappears from the manifest.
	it.each([
		'search',
		'v1',
		'api',
		'graphql',
		'player',
		'watch',
		'r',
		'comments',
	])('leaves the resource name %s alone', (seg) => {
		expect(templateSegment(seg)).toBe(seg);
	});

	it('keeps a real filename but templates a build hash, extension intact', () => {
		expect(templateSegment('player.js')).toBe('player.js');
		expect(templateSegment('a1b2c3d4e5f6.js')).toBe('{id}.js');
	});

	it('passes an empty segment through so leading slashes survive', () => {
		expect(templateSegment('')).toBe('');
	});
});

describe('parseTarget', () => {
	it('splits host, templated path, and sorted param names', () => {
		expect(parseTarget('https://gql.twitch.tv/gql?a=2&b=1')).toEqual({
			host: 'gql.twitch.tv',
			template: '/gql',
			params: ['a', 'b'],
		});
	});

	// Values are data and change every call; names are the API surface. Keeping
	// values would defeat the grouping this whole module exists to do.
	it('drops param values, keeping names', () => {
		const a = parseTarget('https://x.test/s?q=cats');
		const b = parseTarget('https://x.test/s?q=dogs');
		expect(a).toEqual(b);
	});

	it('handles the pseudo-URLs the instrument emits for non-HTTP primitives', () => {
		expect(parseTarget('rtc:chat').host).toBe('rtc');
		expect(parseTarget('bc:updates').host).toBe('bc');
	});

	it('does not throw on junk', () => {
		expect(() => parseTarget('%%%not a url%%%')).not.toThrow();
	});
});

describe('shapeOfBody', () => {
	it('reduces an object to its key skeleton', () => {
		expect(shapeOfBody({ a: 1, b: 'x' })).toBe('{a:number,b:string}');
	});

	it('describes an array by its first element, not its length', () => {
		expect(shapeOfBody([{ id: 1 }, { id: 2 }, { id: 3 }])).toBe('[{id:number}]');
	});

	it('stops descending so a deep payload cannot blow up the manifest', () => {
		expect(shapeOfBody({ a: { b: { c: { d: { e: 1 } } } } })).toContain('…');
	});

	it('distinguishes empty containers from absent ones', () => {
		expect(shapeOfBody([])).toBe('[]');
		expect(shapeOfBody({})).toBe('{}');
		expect(shapeOfBody(null)).toBe('null');
	});
});

describe('buildManifest', () => {
	it('collapses one endpoint called many times into a single counted row', () => {
		const events = Array.from({ length: 250 }, (_, i) =>
			ev({ url: `https://x.test/video/${i}/meta` }),
		);
		const rows = buildManifest(events);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ template: '/video/{id}/meta', count: 250 });
	});

	// The reason for the whole module, stated as a number.
	it('turns a busy page into a manifest a reader can afford', () => {
		const events = Array.from({ length: 1000 }, (_, i) =>
			ev({ url: `https://x.test/item/${i}`, kind: i % 2 ? 'fetch' : 'xhr' }),
		);
		expect(buildManifest(events).length).toBeLessThanOrEqual(2);
	});

	it('keeps a shape seen only once — a rare call is often the interesting one', () => {
		const rows = buildManifest([
			...Array.from({ length: 100 }, () => ev({ url: 'https://x.test/common' })),
			ev({ url: 'https://x.test/rare-admin-endpoint' }),
		]);
		expect(rows.map((r) => r.template)).toContain('/rare-admin-endpoint');
	});

	it('separates rows by primitive, because that is the transport signal', () => {
		const rows = buildManifest([
			ev({ kind: 'fetch', url: 'https://x.test/a' }),
			ev({ kind: 'eventsource', url: 'https://x.test/a' }),
		]);
		expect(rows).toHaveLength(2);
	});

	it('keeps a replayable example rather than the template alone', () => {
		const rows = buildManifest([ev({ url: 'https://x.test/video/abc123def456/meta' })]);
		expect(rows[0].example).toBe('https://x.test/video/abc123def456/meta');
	});

	it('records distinct initiators up to the cap', () => {
		const rows = buildManifest([
			ev({ initiator: 'at main.js:1' }),
			ev({ initiator: 'at main.js:1' }),
			ev({ initiator: 'at chat.js:9' }),
		]);
		expect(rows[0].initiators).toEqual(['at main.js:1', 'at chat.js:9']);
	});

	it('honours the row cap so a pathological page cannot produce a pathological manifest', () => {
		const events = Array.from({ length: 500 }, (_, i) => ev({ url: `https://x.test/p${i}/fixed` }));
		expect(buildManifest(events).length).toBeLessThanOrEqual(MANIFEST_LIMITS.maxRows);
	});

	it('folds wire events in with a response shape', () => {
		const rows = buildManifest(
			[],
			[{ method: 'GET', url: 'https://x.test/api', body: { items: [] } }],
		);
		expect(rows[0]).toMatchObject({ kind: 'wire', shape: '{items:[]}' });
	});
});

describe('deriveTransports', () => {
	it('marks a transport present with the call shape that proves it', () => {
		const v = deriveTransports(
			buildManifest([ev({ kind: 'eventsource', url: 'https://x.test/stream' })]),
		);
		const sse = v.find((r) => r.transport === 'SSE');
		expect(sse?.present).toBe(true);
		expect(sse?.evidence[0]).toContain('/stream');
	});

	it('marks unobserved transports absent with no evidence', () => {
		const v = deriveTransports(buildManifest([ev({ kind: 'fetch' })]));
		expect(v.find((r) => r.transport === 'WebRTC')).toMatchObject({
			present: false,
			evidence: [],
		});
	});

	// The night's Twitch miss in miniature: an IRC tunnel and a JSON socket are
	// the same primitive, and a table built from primitives must show it.
	it('reports a WebSocket regardless of what rides inside it', () => {
		const v = deriveTransports(
			buildManifest([ev({ kind: 'websocket', method: 'WS', url: 'wss://irc-ws.chat.x.test/' })]),
		);
		expect(v.find((r) => r.transport === 'WebSocket')?.present).toBe(true);
	});

	it('detects GraphQL by body shape, not only by a /graphql path', () => {
		const v = deriveTransports(
			buildManifest([
				ev({ method: 'POST', url: 'https://x.test/api', body: '{"query":"{me{id}}"}' }),
			]),
		);
		expect(v.find((r) => r.transport === 'GraphQL')?.present).toBe(true);
	});

	it('detects GraphQL on a /gql path with an unreadable body', () => {
		const v = deriveTransports(
			buildManifest([ev({ method: 'POST', url: 'https://gql.x.test/gql' })]),
		);
		expect(v.find((r) => r.transport === 'GraphQL')?.present).toBe(true);
	});

	it('names every transport even when nothing was captured, so absence is stated', () => {
		const v = deriveTransports([]);
		expect(v.length).toBeGreaterThanOrEqual(12);
		expect(v.every((r) => r.present === false)).toBe(true);
	});

	it('renders a table with a row per transport', () => {
		const table = renderTransports(deriveTransports(buildManifest([ev({ kind: 'beacon' })])));
		expect(table).toContain('| Transport | Present | Evidence |');
		expect(table).toMatch(/\| Beacon\/Telemetry \| ✓ \|/);
		expect(table).toMatch(/\| WebTransport \| ✗ \| \(not observed\) \|/);
	});
});

describe('detectChallengePresence', () => {
	// Attribution, not defence. A run carrying discovery aids that then hits a
	// wall cannot say whether the wall was the site's policy or a reaction to
	// being watched — and recording "this site blocks us" from such a run puts a
	// wrong fact in front of every later attempt.
	const row = (host: string, template = '/') => ({
		kind: 'wire' as const,
		method: 'GET',
		host,
		template,
		params: [],
		count: 1,
		example: `https://${host}${template}`,
	});

	it.each([
		['Kasada', 'k.twitchcdn.net', '/abc/def/fp'],
		['DataDome', 'js.datadome.co', '/tags.js'],
		['PerimeterX / HUMAN', 'client.perimeterx.net', '/px/xhr'],
		['Cloudflare', 'example.test', '/cdn-cgi/challenge-platform/x'],
		['reCAPTCHA', 'www.google.com', '/sorry/index'],
		['hCaptcha', 'hcaptcha.com', '/checksiteconfig'],
	])('recognises %s', (vendor, host, path) => {
		const found = detectChallengePresence([row(host, path)]);
		expect(found.map((f) => f.vendor)).toContain(vendor);
	});

	it('reports nothing on a page with no protection', () => {
		expect(detectChallengePresence([row('api.example.test', '/v1/items')])).toEqual([]);
	});

	it('carries the evidence that identified the vendor', () => {
		const [found] = detectChallengePresence([row('k.twitchcdn.net', '/a/b/fp')]);
		expect(found.evidence[0]).toContain('k.twitchcdn.net');
	});

	it('reports each vendor once however many rows matched', () => {
		const rows = Array.from({ length: 10 }, (_, i) => row('js.datadome.co', `/tag${i}.js`));
		const found = detectChallengePresence(rows);
		expect(found).toHaveLength(1);
		expect(found[0].evidence.length).toBeLessThanOrEqual(3);
	});

	// An ordinary CDN path must not read as a wall, or the warning becomes noise
	// and gets ignored at exactly the moment it matters.
	it.each([
		'cdn.example.test/assets/k.js',
		'example.test/api/track',
		'static.test/pixel.gif',
	])('does not flag %s', (url) => {
		const [host, ...rest] = url.split('/');
		expect(detectChallengePresence([row(host, `/${rest.join('/')}`)])).toEqual([]);
	});
});

describe('adaptive media is provable without an MSE append', () => {
	// The primitive is the weaker evidence. `appendBuffer` fires only when the
	// page demuxes; a player that fetches and appends inside a worker leaves no
	// MSE event, so a live site streaming video reported this row absent while
	// its playlist sat in the captured traffic. A discovery agent overrode the
	// tool by reading the wire — the tool should not have needed overriding.
	const row = (template, host = 'cdn.test') => ({
		kind: 'wire',
		method: 'GET',
		host,
		template,
		params: [],
		count: 1,
		example: `https://${host}${template}`,
	});

	it.each([
		'/api/v2/channel/hls/abc.m3u8',
		'/v1/segment/x.mpd',
		'/hls/stream/index',
		'/dash/manifest',
	])('marks HLS/Media present from %s', (template) => {
		const v = deriveTransports([row(template)]);
		expect(v.find((t) => t.transport === 'HLS/Media')?.present).toBe(true);
	});

	it('still recognises an MSE append when the page does demux', () => {
		const v = deriveTransports(buildManifest([ev({ kind: 'media-append', method: 'DATA' })]));
		expect(v.find((t) => t.transport === 'HLS/Media')?.present).toBe(true);
	});

	it('carries the playlist request as evidence', () => {
		const v = deriveTransports([row('/api/v2/channel/hls/abc.m3u8', 'usher.ttvnw.net')]);
		expect(v.find((t) => t.transport === 'HLS/Media')?.evidence[0]).toContain('usher.ttvnw.net');
	});

	// A TypeScript source file ends .ts, and so does an HLS segment. Matching the
	// extension alone would mark every repo that serves its own sources as
	// streaming video.
	it.each(['/static/app.ts', '/assets/main.js', '/api/items'])('does not flag %s', (template) => {
		const v = deriveTransports([row(template)]);
		expect(v.find((t) => t.transport === 'HLS/Media')?.present).toBe(false);
	});
});
