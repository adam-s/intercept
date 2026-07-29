/**
 * Unit pins for discover-probe's analysis helpers. No network, no browser —
 * which is why discover-probe.mjs guards its main flow to direct invocation.
 */

import { describe, expect, it } from 'vitest';
import {
	contentTypeOf,
	PAGINATION_KEYS,
	PAGINATION_SELECTORS,
	paginationParams,
	parseArgs,
	summarize,
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
	it.each([
		['new WebSocket("wss://x")', 'websocket'],
		['const s = new EventSource("/stream")', 'sse'],
		['fetch("/graphql")', 'graphql'],
		['application/grpc-web+proto', 'grpc-web'],
		['src="/v/master.m3u8"', 'hls-dash'],
		['protobuf.decode(b)', 'protobuf'],
		['new RTCPeerConnection()', 'webrtc'],
	])('flags %s as %s', (source, expected) => {
		expect(transportMarkers(source)).toContain(expected);
	});

	it('reports nothing for an ordinary bundle', () => {
		expect(transportMarkers('function add(a,b){return a+b}')).toEqual([]);
	});

	it('reports every transport a bundle references', () => {
		const markers = transportMarkers('new WebSocket("wss://a"); fetch("/graphql"); v.src=".m3u8"');
		expect(markers.sort()).toEqual(['graphql', 'hls-dash', 'websocket']);
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
