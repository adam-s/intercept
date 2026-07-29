/**
 * Pins for the scorer that turns a recall floor into a recall score.
 *
 * The distinction it exists to hold: captured traffic says what fired, never
 * what did not. Every number this project produced before was that floor
 * reported as a score, which made runs incomparable. A denominator changes that
 * — and only if the scorer is honest about surplus and staleness, because a
 * scorer that quietly absorbs either produces a number nobody should trust.
 */

import { describe, expect, it } from 'vitest';
import { parseArgs, render, score } from '../score-recall.mjs';

const key = {
	target: 'x.test',
	asOf: '2026-07-29',
	transports: [
		{ transport: 'GraphQL', endpoints: ['gql.x.test'], note: 'persisted queries' },
		{ transport: 'WebSocket', endpoints: ['wss://x.test/ws'], note: 'three sockets, not one' },
		{ transport: 'SSE', endpoints: ['x.test/events'] },
	],
};
const v = (t, present) => ({ transport: t, present, evidence: [] });

describe('score', () => {
	it('counts a transport the run found', () => {
		const r = score(key, [v('GraphQL', true), v('WebSocket', false), v('SSE', false)]);
		expect(r.hit).toEqual(['GraphQL']);
		expect(r.recall).toBeCloseTo(1 / 3);
	});

	// The miss carries its note, because "why it was easy to miss" is the whole
	// lesson; a bare list of names teaches nothing.
	it('returns the missed rows with the reason they are easy to miss', () => {
		const r = score(key, [v('GraphQL', true)]);
		expect(r.missed.map((m) => m.transport)).toEqual(['WebSocket', 'SSE']);
		expect(r.missed[0].note).toContain('three sockets');
	});

	it('scores a perfect run at 1', () => {
		const r = score(
			key,
			key.transports.map((t) => v(t.transport, true)),
		);
		expect(r.recall).toBe(1);
		expect(r.missed).toEqual([]);
	});

	// A row present in the run and absent from the key is either a real find the
	// key should gain or a misattribution. Absorbing it silently would inflate.
	it('reports a transport beyond the key rather than counting it', () => {
		const r = score(key, [v('GraphQL', true), v('JSONP', true)]);
		expect(r.surplus).toEqual(['JSONP']);
		expect(r.recall).toBeCloseTo(1 / 3);
	});

	it('ignores rows the run marked absent', () => {
		expect(score(key, [v('GraphQL', false)]).hit).toEqual([]);
	});

	it('does not divide by zero on an empty key', () => {
		expect(score({ target: 'x', transports: [] }, [v('GraphQL', true)]).recall).toBe(0);
	});

	it('handles a run that reported nothing', () => {
		const r = score(key, []);
		expect(r.recall).toBe(0);
		expect(r.missed).toHaveLength(3);
	});

	// A key is what sources said on a date, not a permanent fact — a stale one
	// reports false misses, which is worse than having no key.
	it('carries the key date forward so a miss can be re-verified', () => {
		expect(score(key, []).asOf).toBe('2026-07-29');
	});
});

describe('render', () => {
	it('marks hits and misses distinctly and shows the fraction', () => {
		const out = render(score(key, [v('GraphQL', true)]));
		expect(out).toContain('✓ GraphQL');
		expect(out).toContain('✗ MISSED  WebSocket');
		expect(out).toContain('1/3 = 33%');
	});

	it('warns that the key can be stale rather than presenting it as fact', () => {
		expect(render(score(key, []))).toMatch(/not a fact|Re-verify/);
	});

	it('flags surplus with what it might mean', () => {
		expect(render(score(key, [v('JSONP', true)]))).toContain('beyond the key');
	});
});

describe('parseArgs', () => {
	it('requires nothing and defaults to report-only', () => {
		expect(parseArgs([])).toMatchObject({ target: null, run: null, min: 0 });
	});

	it('reads the uniform flags', () => {
		expect(parseArgs(['--target=twitch', '--run=a.json', '--min=0.8', '--json'])).toMatchObject({
			target: 'twitch',
			run: 'a.json',
			min: 0.8,
			json: true,
		});
	});
});
