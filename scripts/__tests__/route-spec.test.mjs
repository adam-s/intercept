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
	isRecordableStatus,
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
		expect(targets.map((t) => t.path)).toEqual(['/api/y/search', '/api/y/stream']);
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
		expect(targets.map((t) => t.path)).toContain('/api/y/chart/MSFT?range=5d');
		expect(targets.map((t) => t.path)).toContain('/api/y/search?q=tesla');
		expect(skipped).toEqual(['POST /api/y/order']);
	});

	it('does not also probe a route bare once an example covers it', () => {
		const { targets } = probeTargets(routes, ['GET /api/y/search?q=tesla']);
		expect(targets.map((t) => t.path)).not.toContain('/api/y/search');
	});

	it('probes every example when a route declares several', () => {
		const { targets } = probeTargets(
			['GET /api/y/page/:n'],
			['GET /api/y/page/1', 'GET /api/y/page/2'],
		);
		expect(targets.map((t) => t.path)).toEqual(['/api/y/page/1', '/api/y/page/2']);
	});

	// Superseded deliberately: this used to assert that non-GET examples were
	// ignored, which left one route per domain permanently unchecked. A declared
	// example is now probed whatever its verb — see the group at the end of this
	// file for why declaring one is the safety assertion.
	it('probes a non-GET example rather than ignoring it', () => {
		const { targets, skipped } = probeTargets(routes, ['POST /api/y/order?x=1']);
		expect(targets).toContainEqual({ method: 'POST', path: '/api/y/order?x=1' });
		expect(skipped).not.toContain('POST /api/y/order');
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
		expect(targets).toEqual([{ method: 'GET', path: '/api/x/post/aww/1v96p9o' }]);
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

describe('a recursive structure is described once, not per level', () => {
	/**
	 * The third face of the same defect, found on a comment thread. A tree's
	 * DEPTH is content: the baseline recorded a story with a deep reply chain and
	 * asserted it against a shallower one, so the check failed because somebody
	 * had answered a comment. Spelling the nesting out also spent the depth budget
	 * re-describing one type, so the ellipsis landed mid-structure and two shapes
	 * that agreed printed as though they differed.
	 */
	const node = (d) =>
		d === 0
			? { id: 'x', text: 't', children: [] }
			: { id: 'x', text: 't', children: [node(d - 1)] };

	it('gives the same shape whatever the nesting depth', () => {
		expect(shapeOf({ comments: [node(2)] })).toBe(shapeOf({ comments: [node(7)] }));
	});

	it('describes the repeat rather than unrolling it', () => {
		expect(shapeOf({ comments: [node(3)] })).toBe(
			'{comments:[{children:[{↻}],id:string,text:string}]}',
		);
	});

	it('accepts a deeper thread against a shallower baseline', () => {
		expect(
			diffShape(shapeOf({ comments: [node(1)] }), shapeOf({ comments: [node(9)] })).verdict,
		).toBe('no-signal-flipped');
	});

	// The collapse must not swallow a real change. A node that loses a field is
	// still a regression, however deep the tree goes.
	it('still fails when the repeating node loses a field', () => {
		const thin = { id: 'x', children: [] };
		expect(diffShape(shapeOf({ comments: [node(3)] }), shapeOf({ comments: [thin] })).verdict).toBe(
			'unexpected-regression',
		);
	});

	it('does not collapse two unrelated single-key objects', () => {
		expect(shapeOf({ a: { z: 1 }, b: { z: 2 } })).toBe('{a:{z:number},b:{z:number}}');
	});
});

describe('a failing response never becomes the expected shape', () => {
	/**
	 * This gate exists because the rule alone did not hold. "Do not record while
	 * rate-limited" was written down, and then a discovery run recorded
	 * `{error:string}` as an accepted shape for six routes on a host that was
	 * refusing it — and afterwards, so did I, having just written the warning.
	 * Those routes would have passed over an error response for good.
	 *
	 * The pure part is the predicate; the runner refuses and reports.
	 */
	it.each([200, 201, 204, 299])('records a shape from HTTP %i', (status) => {
		expect(isRecordableStatus(status)).toBe(true);
	});

	it.each([301, 400, 403, 404, 429, 500, 502, 503])('refuses HTTP %i', (status) => {
		expect(isRecordableStatus(status)).toBe(false);
	});
});

describe('a declared example is probed whatever its verb', () => {
	/**
	 * Filtering to GET left one route per domain permanently unprobed — a player
	 * control, a comment page, a fixture — each of which declares a concrete
	 * example and answers 200 with real data. "A route nothing calls is not a
	 * route this tier has checked" applied to those too.
	 *
	 * Declaring the example is the safety assertion: an example must be a real
	 * callable invocation, so writing one for a non-GET route says this call is
	 * safe unattended. A state-changing route declares none, and then correctly
	 * reports as unprobed.
	 */
	it('probes a POST route that declares a POST example', () => {
		const routes = ['POST /api/x/player/:id/control'];
		const examples = ['POST /api/x/player/demo/control'];
		const { targets, skipped } = probeTargets(routes, examples);
		expect(targets).toEqual([{ method: 'POST', path: '/api/x/player/demo/control' }]);
		expect(skipped).toEqual([]);
	});

	it('still reports a non-GET route that declares nothing', () => {
		const { targets, skipped } = probeTargets(['DELETE /api/x/thing/:id'], []);
		expect(targets).toEqual([]);
		expect(skipped).toEqual(['DELETE /api/x/thing/:id']);
	});

	// The method-agreement rule from the fix above must survive this change.
	it('does not let a POST example vouch for a same-stem GET route', () => {
		const routes = ['GET /api/x/player/:id', 'POST /api/x/player/:id/control'];
		const { skipped } = probeTargets(routes, ['POST /api/x/player/demo/control']);
		expect(skipped).toContain('GET /api/x/player/:id');
	});
});

describe('a route may declare a non-2xx as one of its answers', () => {
	/**
	 * Some resources are genuinely not always present — a live broadcast when
	 * nobody is on air — and for those, "there is none right now" is a complete
	 * answer rather than a fault. A permanently red route is worse than useless:
	 * it teaches a reader to skip the domain.
	 *
	 * Narrow on purpose. This is not "accept any status", and the obligation
	 * travels with it: the transport must be proved somewhere deterministic.
	 */
	it('accepts a declared status', () => {
		const findings = checkResponse({
			status: 404,
			contentType: 'application/json',
			body: { live: false },
			contractualStatuses: [404],
		});
		expect(findings.filter((f) => f.check === 'status')).toEqual([]);
	});

	it('still fails an undeclared status', () => {
		const findings = checkResponse({
			status: 500,
			contentType: 'application/json',
			body: { error: 'boom' },
			contractualStatuses: [404],
		});
		expect(findings.some((f) => f.check === 'status')).toBe(true);
	});

	it('declaring nothing keeps the default, so this cannot loosen a route by accident', () => {
		const findings = checkResponse({
			status: 404,
			contentType: 'application/json',
			body: { live: false },
		});
		expect(findings.some((f) => f.check === 'status')).toBe(true);
	});
});

describe('a nullable field and an empty list are content too', () => {
	/**
	 * Observed on live directory data. `primaryColorHex` reads `string` for a
	 * streamer who chose a colour and `null` for one who did not, and
	 * `contentClassificationLabels` reads `[]` for an unlabelled stream and
	 * `[{…}]` for a labelled one. Recording either from whichever row happened to
	 * sort first made the pin depend on who was broadcasting.
	 */
	const rowsA = {
		items: [
			{ c: 'x', labels: [] },
			{ c: null, labels: [{ t: 'y' }] },
		],
	};
	const rowsB = {
		items: [
			{ c: null, labels: [{ t: 'z' }] },
			{ c: 'q', labels: [] },
		],
	};

	it('gives two samples sharing no identical row the same shape', () => {
		expect(shapeOf(rowsA)).toBe(shapeOf(rowsB));
	});

	it('records the variation rather than one arm of it', () => {
		expect(shapeOf(rowsA)).toBe('{items:[{c:null|string,labels:[]|[{t:string}]}]}');
	});

	it('accepts the other sample against a recorded baseline', () => {
		expect(diffShape(shapeOf(rowsA), shapeOf(rowsB)).verdict).toBe('no-signal-flipped');
	});

	// The union must not swallow a real change: a field going from a string to a
	// number everywhere is a regression, not a nullable field.
	it('still fails when a type changes outright', () => {
		const changed = {
			items: [
				{ c: 1, labels: [] },
				{ c: 2, labels: [{ t: 'y' }] },
			],
		};
		expect(diffShape(shapeOf(rowsA), shapeOf(changed)).verdict).toBe('unexpected-regression');
	});
});

describe('the record gate and the status declaration agree', () => {
	/**
	 * They disagreed when both were new: the status check accepted a declared 404
	 * while the recorder refused to record what that 404 returns, so the route was
	 * permanently without a baseline. Two mechanisms writing one outcome have to
	 * apply the same test, which is the third time that has come up here.
	 */
	it('records a declared status, because it is an answer and not a failure', () => {
		expect(isRecordableStatus(404, [404])).toBe(true);
	});

	it('still refuses an undeclared failure, which is the hole this gate closes', () => {
		expect(isRecordableStatus(404, [])).toBe(false);
		expect(isRecordableStatus(429, [404])).toBe(false);
		expect(isRecordableStatus(502, [])).toBe(false);
	});

	it('a success needs no declaration', () => {
		expect(isRecordableStatus(200)).toBe(true);
	});
});

describe('a nested object merges rather than alternating', () => {
	/**
	 * The first attempt at the union rendered each distinct row shape as its own
	 * arm, so `broadcaster:{…}|{…}` grew an arm per combination of nullable fields
	 * and no two runs against a live listing agreed. Merging field-wise is what
	 * makes the union stable.
	 */
	const mk = (colour, labels) => ({ b: { id: '1', colour }, labels });
	const A = { items: [mk('x', []), mk(null, [{ t: 'y' }])] };
	const B = { items: [mk(null, [{ t: 'z' }]), mk('q', [])] };

	it('merges the nested fields instead of listing whole-object arms', () => {
		expect(shapeOf(A)).toBe('{items:[{b:{colour:null|string,id:string},labels:[]|[{t:string}]}]}');
	});

	it('agrees across samples that share no identical row', () => {
		expect(shapeOf(A)).toBe(shapeOf(B));
		expect(diffShape(shapeOf(A), shapeOf(B)).verdict).toBe('no-signal-flipped');
	});

	it('still fails when a nested field changes type outright', () => {
		const changed = { items: [mk(1, []), mk(2, [{ t: 'y' }])] };
		expect(diffShape(shapeOf(A), shapeOf(changed)).verdict).toBe('unexpected-regression');
	});
});

describe('a map whose values differ is still a map', () => {
	/**
	 * The first map rule required every value to render identically, so a real
	 * feature-flag table — each flag carrying its own variations — fell through to
	 * being enumerated key by key. That pinned a third party's release schedule
	 * into the contract, which is the thing the rule existed to prevent.
	 *
	 * Values that are all objects are a population, exactly like an array's
	 * elements, so they merge by the same rule.
	 */
	const flags = (names) =>
		Object.fromEntries(
			names.map((n, i) => [n, { key: n, enabled: true, ...(i % 2 ? { variants: { a: 1 } } : {}) }]),
		);

	it('collapses the keys and merges the values', () => {
		expect(shapeOf({ flags: flags(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) })).toBe(
			'{flags:{*:{enabled:boolean,key:string,variants?:{a:number}}}}',
		);
	});

	it('agrees across entirely different key sets', () => {
		const a = shapeOf({ flags: flags(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) });
		const b = shapeOf({ flags: flags(['q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z']) });
		expect(diffShape(a, b).verdict).toBe('no-signal-flipped');
	});

	// A struct must not be swept up by this. Its key names are the schema.
	it('leaves a small struct enumerated', () => {
		expect(shapeOf({ id: 'x', name: 'y' })).toBe('{id:string,name:string}');
	});
});
