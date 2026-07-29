/**
 * Unit pins for discover-probe's analysis helpers. No network, no browser —
 * which is why discover-probe.mjs guards its main flow to direct invocation.
 */

import { describe, expect, it } from 'vitest';
import {
	contentTypeOf,
	contradictions,
	endpointLiterals,
	extractHighValueClues,
	extractHosts,
	extractSnippets,
	hydrationMarkers,
	PAGINATION_KEYS,
	PAGINATION_SELECTORS,
	paginationParams,
	parseArgs,
	summarize,
	TRANSPORT_SIGNATURES,
	transportEvidence,
	transportMarkers,
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
