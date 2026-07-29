/**
 * Unit pins for route-spec's pure checks. Drives the real logic over fixtures
 * with no network and no server — which is why route-spec.mjs guards its main
 * flow to direct invocation.
 */

import { describe, expect, it } from 'vitest';
import {
	checkCompleteness,
	checkResponse,
	diffShape,
	isProbeable,
	parseArgs,
	probeTargets,
	shapeOf,
} from '../route-spec.mjs';

describe('parseArgs', () => {
	it('applies the documented defaults', () => {
		const o = parseArgs([]);
		expect(o).toMatchObject({
			record: false,
			domain: null,
			label: 'latest',
			// Raised past the reference domain's own route count: a lower default
			// made a full run silently partial, and "not probed" reads a lot like
			// "passed" at a glance.
			budget: 100,
			port: 3001,
		});
	});

	it('reads the uniform flags', () => {
		const o = parseArgs([
			'--record',
			'--domain=boardshop',
			'--label=pre-deploy',
			'--budget=5',
			'--wall-clock=60',
		]);
		expect(o).toMatchObject({ record: true, domain: 'boardshop', label: 'pre-deploy', budget: 5 });
		expect(o.wallClock).toBe(60_000);
	});
});

describe('shapeOf', () => {
	it('records structure, never values', () => {
		expect(shapeOf({ b: 1, a: 'x' })).toBe('{a:string,b:number}');
		// Same shape, different data — a baseline must not go red on this.
		expect(shapeOf({ a: 'x', b: 1 })).toBe(shapeOf({ a: 'zzz', b: 999 }));
	});

	it('represents an array by its element, not its length', () => {
		expect(shapeOf([{ id: 1 }])).toBe('[{id:number}]');
		expect(shapeOf([{ id: 1 }])).toBe(shapeOf([{ id: 1 }, { id: 2 }, { id: 3 }]));
		expect(shapeOf([])).toBe('[]');
	});

	it('distinguishes a changed field type', () => {
		expect(shapeOf({ price: 10 })).not.toBe(shapeOf({ price: '10' }));
	});

	it('bounds recursion so a cyclic-looking nest cannot run away', () => {
		let deep = { v: 1 };
		for (let i = 0; i < 20; i++) deep = { v: deep };
		expect(shapeOf(deep)).toContain('…');
	});
});

describe('checkCompleteness — the invariant that a route reports what it got', () => {
	it('flags silent truncation', () => {
		const r = checkCompleteness({ items: [1, 2, 3], total: 100 });
		expect(r.verdict).toBe('silent-truncation');
		expect(r.itemCount).toBe(3);
		expect(r.indicatedTotal).toBe(100);
	});

	it.each([
		'hasMore',
		'nextCursor',
		'incomplete',
		'truncated',
	])('accepts truncation declared via %s', (key) => {
		const r = checkCompleteness({ items: [1], total: 50, [key]: true });
		expect(r.verdict).toBe('incomplete-declared');
	});

	it('does not accept a falsy declaration as a declaration', () => {
		// hasMore:false while returning 1 of 50 is a lie, not a disclosure.
		expect(checkCompleteness({ items: [1], total: 50, hasMore: false }).verdict).toBe(
			'silent-truncation',
		);
	});

	it('passes a complete result', () => {
		expect(checkCompleteness({ items: [1, 2], total: 2 }).verdict).toBe('complete');
	});

	it.each([
		'items',
		'data',
		'results',
		'entries',
		'records',
		'rows',
		'products',
		'list',
	])('finds the item collection under "%s"', (key) => {
		expect(checkCompleteness({ [key]: [1], total: 9 }).verdict).toBe('silent-truncation');
	});

	it.each([
		'total',
		'totalCount',
		'total_count',
		'totalItems',
		'totalResults',
		'count',
	])('finds the indicated total under "%s"', (key) => {
		expect(checkCompleteness({ items: [1], [key]: 9 }).verdict).toBe('silent-truncation');
	});

	it('is not applicable without both halves', () => {
		expect(checkCompleteness({ items: [1, 2] }).verdict).toBe('not-applicable');
		expect(checkCompleteness({ total: 5 }).verdict).toBe('not-applicable');
		expect(checkCompleteness('a string').verdict).toBe('not-applicable');
		expect(checkCompleteness(null).verdict).toBe('not-applicable');
	});

	it('treats a bare array as complete — there is nothing claiming otherwise', () => {
		expect(checkCompleteness([1, 2, 3]).verdict).toBe('not-applicable');
	});
});

describe('diffShape', () => {
	it('reports a new route rather than failing it', () => {
		expect(diffShape(undefined, '{a:number}').verdict).toBe('new-route');
	});

	it('passes an unchanged shape', () => {
		expect(diffShape('{a:number}', '{a:number}').verdict).toBe('no-signal-flipped');
	});

	it('flags drift', () => {
		const r = diffShape('{a:number}', '{a:string}');
		expect(r.verdict).toBe('unexpected-regression');
		expect(r.detail).toContain('shape changed');
	});
});

describe('checkResponse', () => {
	const ok = { status: 200, contentType: 'application/json', body: { items: [1], total: 1 } };

	it('passes a well-formed response', () => {
		expect(checkResponse({ ...ok, baselineShape: shapeOf(ok.body) })).toEqual([]);
	});

	it('fails a non-2xx status', () => {
		const f = checkResponse({ ...ok, status: 500, baselineShape: shapeOf(ok.body) });
		expect(f.map((x) => x.check)).toContain('status');
	});

	it('fails a route serving markup — the error-page-as-data case', () => {
		const f = checkResponse({ status: 200, contentType: 'text/html', body: undefined });
		expect(f.map((x) => x.check)).toContain('content-type');
	});

	it('fails silent truncation', () => {
		const body = { items: [1], total: 99 };
		const f = checkResponse({
			status: 200,
			contentType: 'application/json',
			body,
			baselineShape: shapeOf(body),
		});
		expect(f.map((x) => x.check)).toContain('completeness');
	});

	it('fails shape drift', () => {
		const f = checkResponse({ ...ok, baselineShape: '{items:[string],total:number}' });
		expect(f.map((x) => x.check)).toContain('shape');
	});

	it('reports content-type once, not once per downstream check', () => {
		const f = checkResponse({ status: 200, contentType: 'text/html', body: undefined });
		expect(f).toHaveLength(1);
	});
});

describe('isProbeable', () => {
	it.each([
		['GET /api/boardshop/products', true],
		['POST /api/boardshop/search', false],
		['GET /api/boardshop/product/:sku', false],
		['GET /api/boardshop/files/*', false],
	])('%s → %s', (route, expected) => {
		expect(isProbeable(route)).toBe(expected);
	});
});

describe('probeTargets', () => {
	const routes = [
		'GET /api/y/search',
		'GET /api/y/chart/:symbol',
		'GET /api/y/stream',
		'POST /api/y/order',
	];

	it('probes bare paths when no examples are declared', () => {
		const { targets, skipped } = probeTargets(routes, []);
		expect(targets).toEqual(['/api/y/search', '/api/y/stream']);
		// The parameterized GET and the POST are both uncallable as declared.
		expect(skipped).toEqual(['GET /api/y/chart/:symbol', 'POST /api/y/order']);
	});

	// The whole point: a route whose bare path is a 400 or not a URL is
	// invisible without an example, and invisible reads as passing.
	it('uses declared examples to reach otherwise unprobeable routes', () => {
		const { targets, skipped } = probeTargets(routes, [
			'GET /api/y/chart/MSFT?range=5d',
			'GET /api/y/search?q=tesla',
		]);
		expect(targets).toContain('/api/y/chart/MSFT?range=5d');
		expect(targets).toContain('/api/y/search?q=tesla');
		expect(skipped).toEqual(['POST /api/y/order']);
	});

	it('does not also probe a route bare once an example covers it', () => {
		const { targets } = probeTargets(routes, ['GET /api/y/search?q=tesla']);
		expect(targets).not.toContain('/api/y/search');
	});

	it('probes every example when a route declares several', () => {
		const { targets } = probeTargets(
			['GET /api/y/page/:n'],
			['GET /api/y/page/1', 'GET /api/y/page/2'],
		);
		expect(targets).toEqual(['/api/y/page/1', '/api/y/page/2']);
	});

	it('ignores non-GET examples', () => {
		const { targets } = probeTargets(routes, ['POST /api/y/order?x=1']);
		expect(targets).not.toContain('/api/y/order?x=1');
	});

	it('returns nothing for a domain with no routes', () => {
		expect(probeTargets([], [])).toEqual({ targets: [], skipped: [] });
	});
});

describe('diffShape accepts a set of shapes', () => {
	// An escalation route returns its API's shape, then its fallback's once the
	// upstream rate-limits. Both are correct; pinning one makes the other red.
	it('passes any recorded shape', () => {
		const accepted = ['{a:number}', '{b:string}'];
		expect(diffShape(accepted, '{a:number}').verdict).toBe('no-signal-flipped');
		expect(diffShape(accepted, '{b:string}').verdict).toBe('no-signal-flipped');
	});

	it('still fails a shape in neither', () => {
		const r = diffShape(['{a:number}', '{b:string}'], '{c:boolean}');
		expect(r.verdict).toBe('unexpected-regression');
		expect(r.detail).toContain('none of 2');
	});

	it('keeps the single-shape form working', () => {
		expect(diffShape('{a:number}', '{a:number}').verdict).toBe('no-signal-flipped');
		expect(diffShape('{a:number}', '{a:string}').verdict).toBe('unexpected-regression');
	});
});

describe('a streaming route is asserted on its own terms', () => {
	// Judging an event stream by the JSON rule reported a working live feed as a
	// route serving an error page — the checker failing to understand a transport
	// rather than the route failing. Streaming routes are exemplars now, so the
	// checker has to know the shape.
	const sse = 'event: open\ndata: {"symbols":["AAPL"]}\n\nevent: pricing\ndata: {"id":"AAPL"}\n\n';

	it('accepts an event stream that delivered events', () => {
		expect(checkResponse({ status: 200, contentType: 'text/event-stream', raw: sse })).toEqual([]);
	});

	it('does not fault it for being non-JSON', () => {
		const f = checkResponse({ status: 200, contentType: 'text/event-stream', raw: sse });
		expect(f.map((x) => x.check)).not.toContain('content-type');
	});

	// The failure that matters for a stream is silence, and a status check cannot
	// see it: a channel that opens and carries nothing returns 200 with a body.
	it('fails a stream that opened and delivered nothing', () => {
		const f = checkResponse({ status: 200, contentType: 'text/event-stream', raw: '' });
		expect(f.map((x) => x.check)).toContain('stream');
	});

	it('fails a stream with events but no data lines', () => {
		const f = checkResponse({
			status: 200,
			contentType: 'text/event-stream',
			raw: 'event: open\n\n',
		});
		expect(f[0].detail).toContain('no data line');
	});

	it.each(['application/x-ndjson', 'application/stream+json'])('handles %s too', (ct) => {
		expect(checkResponse({ status: 200, contentType: ct, raw: 'data: {"a":1}\n' })).toEqual([]);
	});

	it('still faults a JSON route that served markup', () => {
		const f = checkResponse({ status: 200, contentType: 'text/html', body: undefined });
		expect(f.map((x) => x.check)).toContain('content-type');
	});
});

describe('coverage is a claim about one route, not one path', () => {
	/**
	 * Found on a live run: `✓ 17 route(s) passed` printed over a POST route that
	 * nothing had called. Matching stripped the method first, so a GET example
	 * covered a same-stem POST route; the POST route then dropped out of
	 * `skipped` — it is listed only when *not* covered — so the "not probed"
	 * line never printed and the run reported a clean pass over a gap.
	 */
	it('a GET example does not mark a same-stem POST route covered', () => {
		const routes = ['GET /api/x/post/:sub/:id', 'POST /api/x/post/:sub/:id/comments/more'];
		const examples = ['GET /api/x/post/aww/1v96p9o'];
		const { skipped } = probeTargets(routes, examples);
		expect(skipped).toContain('POST /api/x/post/:sub/:id/comments/more');
	});

	it('still covers the GET route its example names', () => {
		const routes = ['GET /api/x/post/:sub/:id'];
		const examples = ['GET /api/x/post/aww/1v96p9o'];
		const { targets, skipped } = probeTargets(routes, examples);
		expect(targets).toEqual(['/api/x/post/aww/1v96p9o']);
		expect(skipped).toEqual([]);
	});

	// An unprobeable route must be counted so the runner can say so. Silence here
	// is the whole defect: nothing failed, so nothing was reported.
	it('reports every non-GET route as skipped so the runner can announce it', () => {
		const routes = ['POST /api/x/a', 'DELETE /api/x/b', 'GET /api/x/c'];
		const { skipped } = probeTargets(routes, []);
		expect(skipped.sort()).toEqual(['DELETE /api/x/b', 'POST /api/x/a']);
	});
});

describe('a shape pin describes schema, never content', () => {
	/**
	 * Three live failures shared one cause: the pin was treating variable content
	 * as though it were structure, so the check went red on the site doing
	 * ordinary things.
	 */
	it('takes the union across array elements, not element zero', () => {
		// A delta stream: each frame carries only what changed.
		const body = {
			frames: [
				{ id: 'AAPL', price: 1, dayVolume: 9 },
				{ id: 'TSLA', price: 2 },
			],
		};
		const shape = shapeOf(body);
		expect(shape).toContain('dayVolume?:');
		expect(shape).toContain('price:');
	});

	it('accepts a later sample missing an optional key', () => {
		const recorded = shapeOf({
			frames: [
				{ id: 'A', price: 1, dayVolume: 9 },
				{ id: 'B', price: 2 },
			],
		});
		const later = shapeOf({
			frames: [
				{ id: 'C', price: 3 },
				{ id: 'D', price: 4 },
			],
		});
		expect(diffShape(recorded, later).verdict).toBe('no-signal-flipped');
	});

	it('still fails when a key present in every element disappears', () => {
		const recorded = shapeOf({
			frames: [
				{ id: 'A', price: 1, dayVolume: 9 },
				{ id: 'B', price: 2 },
			],
		});
		const broken = shapeOf({ frames: [{ id: 'C' }, { id: 'D' }] });
		expect(diffShape(recorded, broken).verdict).toBe('unexpected-regression');
	});

	/**
	 * A feature-flag blob: hundreds of keys the site adds and removes on its own
	 * schedule, every value the same shape. Enumerating them pins their release
	 * process, so the route went red whenever they shipped a flag.
	 */
	it('describes a map by its values, so new keys are not a regression', () => {
		const flags = (names) => Object.fromEntries(names.map((n) => [n, { enabled: true }]));
		const before = shapeOf(flags(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']));
		const after = shapeOf(flags(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']));
		expect(before).toBe('{*:{enabled:boolean}}');
		expect(diffShape(before, after).verdict).toBe('no-signal-flipped');
	});

	// A struct is not a map. Its key names *are* the schema, and losing one is
	// exactly what this check exists to catch.
	it('does not treat a small struct as a map', () => {
		const shape = shapeOf({ id: 'x', title: 'y', points: 1 });
		expect(shape).toBe('{id:string,points:number,title:string}');
	});

	it('does not treat a mixed-value object as a map however many keys it has', () => {
		const obj = { a: 1, b: 'x', c: true, d: 1, e: 1, f: 1, g: 1, h: 1, i: 1 };
		expect(shapeOf(obj)).not.toContain('*');
	});
});
