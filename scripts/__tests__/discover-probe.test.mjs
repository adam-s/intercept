/**
 * Unit pins for discover-probe's analysis helpers. No network, no browser —
 * which is why discover-probe.mjs guards its main flow to direct invocation.
 */

import { describe, expect, it } from 'vitest';
import {
	captureVerdict,
	contentTypeOf,
	contradictions,
	coverageDiff,
	endpointLiterals,
	extractHighValueClues,
	extractHosts,
	extractSnippets,
	hydrationMarkers,
	normalizeEndpoint,
	PAGINATION_KEYS,
	PAGINATION_SELECTORS,
	paginationParams,
	parseArgs,
	stripOwnInstrument,
	summarize,
	TRANSPORT_SIGNATURES,
	transportEvidence,
	transportMarkers,
	upstreamMatches,
} from '../discover-probe.mjs';

const entry = (over = {}) => ({
	id: 1,
	method: 'GET',
	url: 'https://x.test/api/items',
	status: 200,
	responseHeaders: { 'content-type': 'application/json' },
	...over,
});

describe('parseArgs', () => {
	it('defaults to a scan', () => {
		expect(parseArgs([])).toMatchObject({ mode: 'scan', port: 3001, budget: 3, json: false });
	});

	it('reads the uniform flags', () => {
		expect(parseArgs(['--mode=probe', '--url=/a?page=2', '--json', '--settle=1000'])).toMatchObject(
			{
				mode: 'probe',
				url: '/a?page=2',
				json: true,
				settle: 1000,
			},
		);
	});
});

describe('paginationParams', () => {
	it.each(PAGINATION_KEYS)('finds "%s" in the query string', (key) => {
		expect(paginationParams(entry({ url: `https://x.test/api?${key}=2` }))).toEqual([key]);
	});

	// A POST that pages via its body is exactly what a URL-only scan misses.
	it('finds pagination keys in a JSON request body', () => {
		const e = entry({ method: 'POST', requestBody: { query: 'x', offset: 40, limit: 20 } });
		expect(paginationParams(e).sort()).toEqual(['limit', 'offset']);
	});

	it('is case-insensitive on the key name', () => {
		expect(paginationParams(entry({ url: 'https://x.test/api?Page=3' }))).toEqual(['Page']);
	});

	it('reports nothing for an endpoint with no pagination', () => {
		expect(paginationParams(entry({ url: 'https://x.test/api/detail?sku=A1' }))).toEqual([]);
	});

	it('survives an unparseable URL and a non-object body', () => {
		expect(paginationParams(entry({ url: ':::', requestBody: 'raw' }))).toEqual([]);
		expect(paginationParams(entry({ requestBody: [1, 2] }))).toEqual([]);
	});

	it('does not double-report a key present in both URL and body', () => {
		const e = entry({ url: 'https://x.test/a?page=2', requestBody: { page: 2 } });
		expect(paginationParams(e)).toEqual(['page']);
	});
});

describe('contentTypeOf', () => {
	it('is tolerant of header casing', () => {
		expect(contentTypeOf(entry({ responseHeaders: { 'Content-Type': 'Application/JSON' } }))).toBe(
			'application/json',
		);
	});

	it('returns empty when absent', () => {
		expect(contentTypeOf(entry({ responseHeaders: {} }))).toBe('');
		expect(contentTypeOf(entry({ responseHeaders: undefined }))).toBe('');
	});
});

describe('transportMarkers', () => {
	// Names are the elimination-table row names, not a second vocabulary — the
	// scanner and the table must agree or a wrong verdict cannot be contradicted.
	it.each([
		['new WebSocket("wss://x")', 'WebSocket'],
		['const s = new EventSource("/stream")', 'SSE'],
		['fetch("/graphql")', 'GraphQL'],
		['application/grpc-web+proto', 'gRPC-Web'],
		['src="/v/master.m3u8"', 'HLS/Media'],
		['protobuf.decode(b)', 'Encoded/Binary'],
	])('flags %s as %s', (source, expected) => {
		expect(transportMarkers(source)).toContain(expected);
	});

	it('reports nothing for an ordinary bundle', () => {
		expect(transportMarkers('function add(a,b){return a+b}')).toEqual([]);
	});

	it('reports every transport a bundle references', () => {
		const markers = transportMarkers('new WebSocket("wss://a"); fetch("/graphql"); v.src=".m3u8"');
		expect(markers).toEqual(expect.arrayContaining(['GraphQL', 'HLS/Media', 'WebSocket']));
	});
});

describe('summarize', () => {
	it('groups repeated calls to one endpoint', () => {
		const rows = summarize([entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ endpoint: 'GET /api/items', count: 3 });
	});

	it('collapses query strings so one endpoint is one row', () => {
		const rows = summarize([
			entry({ id: 1, url: 'https://x.test/api/items?page=1' }),
			entry({ id: 2, url: 'https://x.test/api/items?page=2' }),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0].pagination).toEqual(['page']);
	});

	// Pagination-bearing endpoints are the point of the scan, so they lead.
	it('ranks pagination-bearing endpoints first', () => {
		const rows = summarize([
			entry({ id: 1, url: 'https://x.test/api/a' }),
			entry({ id: 2, url: 'https://x.test/api/a' }),
			entry({ id: 3, url: 'https://x.test/api/a' }),
			entry({ id: 4, url: 'https://x.test/api/b?offset=20' }),
		]);
		expect(rows[0].endpoint).toBe('GET /api/b');
	});

	it('separates methods on the same path', () => {
		const rows = summarize([entry({ id: 1 }), entry({ id: 2, method: 'POST' })]);
		expect(rows.map((r) => r.endpoint).sort()).toEqual(['GET /api/items', 'POST /api/items']);
	});

	it('collects the distinct statuses and content types seen', () => {
		const rows = summarize([
			entry({ id: 1, status: 200 }),
			entry({ id: 2, status: 429, responseHeaders: { 'content-type': 'text/html' } }),
		]);
		expect(rows[0].statuses.sort()).toEqual([200, 429]);
		expect(rows[0].contentTypes.sort()).toEqual(['application/json', 'text/html']);
	});

	it('returns nothing for no traffic', () => {
		expect(summarize([])).toEqual([]);
	});
});

describe('PAGINATION_SELECTORS', () => {
	// A structural pin only — this suite runs in Node, so it cannot parse CSS.
	// Whether the browser accepts these is proven by running --mode=paginate,
	// not here; the check that pays for itself is that the list stays
	// comma-joinable, since paginate injects it as one querySelector argument.
	it('joins into a single selector argument with no empty or quoted entries', () => {
		expect(PAGINATION_SELECTORS.length).toBeGreaterThan(0);
		for (const s of PAGINATION_SELECTORS) {
			expect(s.trim()).not.toBe('');
			expect(s).not.toContain(',');
			expect(s).not.toContain('"');
		}
	});
});

describe('transport signature table', () => {
	it('keys every signature to an elimination-table row name', () => {
		// One table, two consumers. Drift between them is what let a wrong ✗ on
		// "Embedded JSON" survive twice.
		for (const row of [
			'Embedded JSON',
			'JSON API (XHR)',
			'GraphQL',
			'WebSocket',
			'HLS/Media',
			'gRPC-Web',
			'SSE',
			'Encoded/Binary',
		]) {
			expect(Object.keys(TRANSPORT_SIGNATURES)).toContain(row);
		}
	});

	it.each([
		['new WebSocket("wss://x")', 'WebSocket'],
		['new EventSource("/s")', 'SSE'],
		['fetch("/graphql")', 'GraphQL'],
		['v.src = "a.m3u8"', 'HLS/Media'],
		['application/grpc-web+proto', 'gRPC-Web'],
		['<script id="__NEXT_DATA__">', 'Embedded JSON'],
		['<script data-sveltekit-fetched>', 'Embedded JSON'],
	])('finds strong evidence for %s → %s', (src, transport) => {
		expect(transportEvidence(src)[transport].strong.length).toBeGreaterThan(0);
	});

	// The measured failure: probing three framework names and concluding absent.
	it('detects hydration markers no single framework check would find', () => {
		const found = hydrationMarkers('<script data-sveltekit-fetched data-url="/x">{}</script>');
		expect(found.map((f) => f.marker)).toContain('sveltekit');
		expect(hydrationMarkers('<div>nothing</div>')).toEqual([]);
	});

	it('separates library evidence from strong evidence', () => {
		const ev = transportEvidence('import Hls from "hls.js"');
		expect(ev['HLS/Media'].library.length).toBeGreaterThan(0);
		expect(ev['HLS/Media'].strong).toEqual([]);
	});
});

describe('contradictions', () => {
	// A ✗ is a judgment; a strong signature is a fact about the code.
	it('flags a transport marked absent that the source proves present', () => {
		const ev = transportEvidence('new WebSocket("wss://x")');
		expect(contradictions({ WebSocket: false }, ev)).toHaveLength(1);
	});

	it('stays silent when the mark agrees with the evidence', () => {
		const ev = transportEvidence('new WebSocket("wss://x")');
		expect(contradictions({ WebSocket: true }, ev)).toEqual([]);
		expect(contradictions({ SSE: false }, ev)).toEqual([]);
	});

	// Library evidence alone is not proof — a bundled dep can be dead code.
	it('does not contradict on library evidence alone', () => {
		const ev = transportEvidence('import Hls from "hls.js"');
		expect(contradictions({ 'HLS/Media': false }, ev)).toEqual([]);
	});
});

describe('endpointLiterals', () => {
	it('finds API-shaped paths a bundle can reach but traffic never showed', () => {
		const found = endpointLiterals('fetch("/v1/finance/quote");w("/ws/insights/v3")');
		expect(found).toContain('/v1/finance/quote');
		expect(found).toContain('/ws/insights/v3');
	});

	it('ignores ordinary strings', () => {
		expect(endpointLiterals('const msg = "hello world"; x("/")')).toEqual([]);
	});
});

describe('clue extraction', () => {
	const bundle =
		'var n="https://gql.twitch.tv";function f(){return new WebSocket(n+"/ws/v2?token="+r)}' +
		'fetch("/gql",{headers:{"Client-ID":c,"x-device-id":d}});' +
		'o={operationName:"StreamMetadata",extensions:{persistedQuery:{sha256Hash:"abc"}}};' +
		'//# sourceMappingURL=main.js.map';

	// The point of a snippet over a boolean: the surrounding source usually
	// carries the URL construction, which is what you actually need next.
	it('captures the URL construction around a transport hit', () => {
		const ws = extractSnippets(bundle).find((s) => s.transport === 'WebSocket');
		expect(ws.snippet).toContain('/ws/v2?token=');
	});

	it('caps output so a minified bundle cannot flood the budget', () => {
		const huge = 'new WebSocket("wss://a");'.repeat(500);
		expect(extractSnippets(huge, { max: 5 }).length).toBeLessThanOrEqual(5);
	});

	// Not one: a repeated call yields a few distinct leading contexts before the
	// window stabilizes, and two strong patterns match each occurrence. The
	// property that matters is that twenty hits collapse to a handful.
	it('collapses near-duplicate snippets', () => {
		const repeated = 'new WebSocket("wss://same/path");'.repeat(20);
		expect(extractSnippets(repeated).length).toBeLessThan(5);
	});

	it('finds API hosts and ignores analytics CDNs', () => {
		const hosts = extractHosts(`${bundle};x="https://www.google-analytics.com/g"`).map(
			(h) => h.host,
		);
		expect(hosts).toContain('gql.twitch.tv');
		expect(hosts).not.toContain('www.google-analytics.com');
	});

	// A sourcemap is the highest-value find in a minified bundle — it returns
	// original names — so it is reported before anything else.
	it('surfaces sourcemaps, persisted queries, operations, and auth headers', () => {
		const kinds = extractHighValueClues(bundle).map((c) => c.kind);
		expect(kinds).toContain('sourcemap');
		expect(kinds).toContain('persisted-graphql');
		expect(kinds).toContain('graphql-operation');
		expect(kinds).toContain('auth-header');
	});

	it('catches header names that do not start with x-', () => {
		const vals = extractHighValueClues(bundle).map((c) => c.value.toLowerCase());
		expect(vals).toContain('client-id');
	});

	it('returns nothing for source with no clues', () => {
		expect(extractHighValueClues('function add(a,b){return a+b}')).toEqual([]);
		expect(extractSnippets('const x = 1;')).toEqual([]);
	});
});

describe('coverageDiff — the recall floor', () => {
	const entries = [
		{ method: 'GET', url: 'https://gql.twitch.tv/gql' },
		{ method: 'GET', url: 'https://query1.finance.yahoo.com/ws/insights/v3/finance/insights' },
		{ method: 'GET', url: 'https://www.google-analytics.com/collect' },
		{ method: 'DOCUMENT', url: 'https://x.test/' },
	];

	it('drops telemetry and documents, keeping only candidate APIs', () => {
		const d = coverageDiff(entries, [], []);
		expect(d.total).toBe(2);
	});

	// Weak on purpose: a handler's upstream call is declared nowhere, so a
	// confident auto-match would invent coverage that does not exist.
	it('accounts for an endpoint a route visibly names, and no more', () => {
		const d = coverageDiff(entries, ['GET /api/y/insights'], []);
		expect(d.accounted.map((a) => a.endpoint)).toEqual([
			'query1.finance.yahoo.com/ws/insights/v3/finance/insights',
		]);
		expect(d.unaccounted.map((u) => u.endpoint)).toEqual(['gql.twitch.tv/gql']);
		expect(d.recallFloor).toBe(50);
	});

	it('matches via examples as well as route paths', () => {
		const d = coverageDiff(entries, [], ['GET /api/y/x?q=insights']);
		expect(d.accounted).toHaveLength(1);
	});

	it('reports null rather than a misleading 0% when nothing was captured', () => {
		expect(coverageDiff([], [], []).recallFloor).toBeNull();
	});

	it('counts repeat calls to one endpoint once', () => {
		const repeated = [entries[0], entries[0], entries[0]];
		const d = coverageDiff(repeated, [], []);
		expect(d.total).toBe(1);
		expect(d.unaccounted[0].hits).toBe(3);
	});
});

describe('normalizeEndpoint', () => {
	it.each([
		['https://a.test/v2/users/12345678/tweets', 'a.test/v2/users/{id}/tweets'],
		['https://a.test/x/550e8400-e29b-41d4-a716-446655440000', 'a.test/x/{uuid}'],
		['https://a.test/p/DECK-001', 'a.test/p/{id}'],
	])('templates volatile segments in %s', (url, expected) => {
		expect(normalizeEndpoint(url)).toBe(expected);
	});

	it('leaves stable path segments alone', () => {
		expect(normalizeEndpoint('https://a.test/v1/finance/search')).toBe('a.test/v1/finance/search');
	});
});

describe('regressions found by discovery agents', () => {
	// --domain was declared in the usage text and filtered on in the coverage
	// mode, but parseArgs never read it — so opts.domain was always undefined,
	// every mode silently operated on all domains, and `--record` rewrote every
	// baseline including the reference domain's. Two agents independently hit
	// the resulting corruption and reverted it by hand before the cause was found.
	it('parseArgs reads --domain', () => {
		expect(parseArgs(['--domain=twitch']).domain).toBe('twitch');
		expect(parseArgs([]).domain).toBeNull();
	});

	// captureVerdict is called on four runtime paths and was deleted wholesale by
	// a region splice. Nothing caught it: unit tests exercise pure helpers
	// directly, and the runner paths have no coverage, so `--mode=scan` would
	// have thrown ReferenceError in front of a user. The durable guard is
	// biome's noUndeclaredVariables, now enabled; this pins the function itself.
	it('captureVerdict exists and separates absence from breakage', () => {
		expect(typeof captureVerdict).toBe('function');
		expect(captureVerdict([]).verdict).toBe('no-capture');
		expect(captureVerdict([{ method: 'DOCUMENT' }]).verdict).toBe('document-only');
		expect(captureVerdict([{ method: 'GET' }]).verdict).toBe('has-data-traffic');
	});
});

describe('upstreamMatches — declared coverage', () => {
	// String similarity cannot solve this: a route at /r/:subreddit fetches
	// /r/all.json, and the two share almost nothing. Reddit's run reported a 0%
	// recall floor with eight working routes because of it.
	it('matches a captured instance against a declared shape', () => {
		expect(upstreamMatches('www.reddit.com/r/{sub}.json', 'www.reddit.com/r/all.json')).toBe(true);
		expect(upstreamMatches('gql.twitch.tv/gql', 'gql.twitch.tv/gql')).toBe(true);
	});

	it('does not match a different endpoint on the same host', () => {
		expect(
			upstreamMatches('www.reddit.com/r/{sub}.json', 'www.reddit.com/svc/shreddit/events'),
		).toBe(false);
	});

	// Two encoding traps, both found the hard way.
	it('survives percent-encoded braces and extensions on the placeholder', () => {
		expect(upstreamMatches('a.test/x/%7Bid%7D.json', 'a.test/x/42.json')).toBe(true);
	});

	it('lets a declared prefix cover deeper paths but not shallower ones', () => {
		expect(upstreamMatches('a.test/v/x', 'a.test/v/x/y')).toBe(true);
		expect(upstreamMatches('a.test/v/x/y', 'a.test/v/x')).toBe(false);
	});

	it('prefers a declared upstream over the name heuristic', () => {
		const entries = [{ method: 'GET', url: 'https://gql.twitch.tv/gql' }];
		const d = coverageDiff(entries, ['GET /api/twitch/directory/top'], [], ['gql.twitch.tv/gql']);
		expect(d.recallFloor).toBe(100);
	});
});

describe('the scan does not read our own instrument as the target', () => {
	// The instrument is injected into the page, so it becomes part of what a
	// source scan sees. It constructs a WebTransport, patches WebSocket, and
	// carries a `callback=` pattern for JSONP detection — a live run reported all
	// three as findings about the site. That is worse than an ordinary false
	// positive: the evidence looks exactly like a real hit.
	// Excerpted from the shipped instrument rather than invented, so the test
	// fails if the instrument changes shape and the markers stop covering it.
	const OURS = `
		const g = globalThis;
		const events = [];
		g.__ic_egress = events;
		patchCtor('WebTransport', (_inst, args) => rec({ kind: 'webtransport', method: 'OPEN' }));
		originals.set(wrapper, orig);
		if (/[?&](callback|jsonp)=/i.test(String(value))) { rec({ kind: 'jsonp', method: 'GET' }); }
	`;

	it('finds nothing in our own source alone', () => {
		expect(Object.keys(transportEvidence(OURS))).toEqual([]);
	});

	it('still finds the page real transports when ours is mixed in', () => {
		const page = `${OURS}\nfetch('/api/items');\nnew WebSocket('wss://x.test/ws');`;
		const found = Object.keys(transportEvidence(page));
		expect(found).toContain('WebSocket');
		expect(found).toContain('JSON API (XHR)');
		expect(found).not.toContain('WebTransport');
	});

	// Dropping the whole file would trade a false positive for a blind spot.
	it('strips by line, keeping the page code around it', () => {
		const out = stripOwnInstrument(`real.line();\ng.__ic_egress = [];\nother.line();`);
		expect(out).toContain('real.line()');
		expect(out).toContain('other.line()');
		expect(out).not.toContain('__ic_egress');
	});

	it('leaves an uninstrumented source untouched', () => {
		const clean = `fetch('/api');\nnew EventSource('/sse');`;
		expect(stripOwnInstrument(clean)).toBe(clean);
	});

	it('keeps snippets free of our own code', () => {
		expect(extractSnippets(`${OURS}\nfetch('/real/api')`).join(' ')).not.toContain('__ic_egress');
	});
});

describe('structured data comes in three shapes, not one', () => {
	// Every framework marker in the signature names a framework — Next, Nuxt,
	// Remix, Apollo. Semantic markup is a standard, so it reads without knowing
	// what built the page, and it is on a large share of the web because search
	// engines ask for it. A page carrying no hydration payload at all routinely
	// carries the whole record in JSON-LD.
	it.each([
		['JSON-LD', '<script type="application/ld+json">{"@type":"Product"}</script>'],
		['microdata', '<div itemtype="https://schema.org/Product" itemprop="name">'],
		['Open Graph', '<meta property="og:title" content="x">'],
		['Twitter cards', '<meta name="twitter:card" content="summary">'],
	])('detects %s as embedded data', (_name, html) => {
		expect(Object.keys(transportEvidence(html, 'html'))).toContain('Embedded JSON');
	});

	it('still detects framework hydration', () => {
		expect(Object.keys(transportEvidence('<script>__NEXT_DATA__</script>', 'html'))).toContain(
			'Embedded JSON',
		);
	});

	it('does not call an ordinary page embedded data', () => {
		expect(Object.keys(transportEvidence('<p>hello</p>', 'html'))).not.toContain('Embedded JSON');
	});
});

describe('adaptive media is more than one manifest format', () => {
	// The row is named for the format that dominates it, but DASH answers the
	// same question and is not rare. A signature that only knew HLS reported
	// "no adaptive media" for a site streaming over DASH.
	it.each([
		['HLS', 'src="/stream/master.m3u8"'],
		['DASH', 'src="/stream/manifest.mpd"'],
		['DASH content type', 'application/dash+xml'],
		['Smooth Streaming', 'application/vnd.ms-sstr+xml'],
	])('detects %s', (_name, source) => {
		expect(Object.keys(transportEvidence(source))).toContain('HLS/Media');
	});
});
