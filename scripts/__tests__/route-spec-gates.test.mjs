/**
 * Pins for the two gates that decide whether a route-spec run means anything.
 *
 * Both guard the same failure: a green result over work that was never checked.
 * A route missing a declaration gets skipped, and a skipped route reads exactly
 * like a passing one. A run against an instrumented session measures a page no
 * ordinary visitor sees, so its verdict — pass or fail — is about the aids
 * rather than about the site.
 */

import { describe, expect, it } from 'vitest';
import { parseArgs, undeclared } from '../route-spec.mjs';

const route = (over = {}) => ({
	method: 'GET',
	path: '/api/x/items',
	examples: ['/items'],
	upstream: ['x.test/api/items'],
	hasTargetUrl: false,
	...over,
});

describe('undeclared', () => {
	it('passes a fully declared route', () => {
		expect(undeclared([route()])).toEqual([]);
	});

	// The exact obligation a tuned agent dropped while declaring `examples`
	// seven times in the same run.
	it('fails a route that declares no upstream', () => {
		const missing = undeclared([route({ upstream: [] })]);
		expect(missing).toHaveLength(1);
		expect(missing[0].field).toBe('upstream');
	});

	// A targetUrl route already names its upstream; a second copy would drift.
	it('exempts a targetUrl route from declaring upstream', () => {
		expect(undeclared([route({ upstream: [], hasTargetUrl: true })])).toEqual([]);
	});

	it('fails a parameterised route that declares no examples', () => {
		const missing = undeclared([route({ path: '/api/x/item/:id', examples: [] })]);
		expect(missing.map((m) => m.field)).toContain('examples');
	});

	// A bare path is callable from its declaration alone, so an example is
	// optional there — requiring one would be noise, not a check.
	it('allows a bare route with no examples', () => {
		expect(undeclared([route({ examples: [] })])).toEqual([]);
	});

	it('names the route and the reason, so the message is actionable', () => {
		const [m] = undeclared([route({ upstream: [] })]);
		expect(m.route).toBe('/api/x/items');
		expect(m.why.length).toBeGreaterThan(20);
	});

	it('reports every offender rather than stopping at the first', () => {
		expect(undeclared([route({ upstream: [] }), route({ upstream: [] })])).toHaveLength(2);
	});

	it('returns nothing for an empty domain instead of throwing', () => {
		expect(undeclared([])).toEqual([]);
		expect(undeclared()).toEqual([]);
	});
});

describe('the instrumented-session gate', () => {
	// Off by default: the gate has to be the normal path, or it is decoration.
	it('is on unless explicitly waived', () => {
		expect(parseArgs([]).allowInstrumented).toBe(false);
		expect(parseArgs(['--allow-instrumented']).allowInstrumented).toBe(true);
	});

	// The reference domain alone exceeds the old default, which made a full run
	// silently partial — and "not probed" reads a lot like "passed" at a glance.
	it('probes more routes by default than the reference domain has', () => {
		expect(parseArgs([]).budget).toBeGreaterThan(48);
	});
});

describe('the record gate', () => {
	// Recording is destructive and domain-wide. Without a domain it rewrites every
	// baseline it can reach — including reference material whose test server may
	// not be running, whose routes then record their failures as the expected
	// shape. That has happened more than once, and each time it was caught by
	// accident rather than by a check.
	it('is not satisfied by --record alone', () => {
		const o = parseArgs(['--record']);
		expect(o.record).toBe(true);
		expect(o.domain).toBe(null);
	});

	it('is satisfied when a domain is named', () => {
		expect(parseArgs(['--record', '--domain=twitch'])).toMatchObject({
			record: true,
			domain: 'twitch',
		});
	});

	// Asserting without --domain stays allowed: reading every baseline is safe,
	// writing every baseline is not.
	it('does not restrict an assert-only run', () => {
		expect(parseArgs([])).toMatchObject({ record: false, domain: null });
	});
});
