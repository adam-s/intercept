import { describe, expect, it } from 'vitest';
import { deriveCompleteness, withCompleteness } from './completeness.js';

describe('deriveCompleteness', () => {
	it('reports incompleteness when items fall short of the indicated total', () => {
		expect(deriveCompleteness({ items: [1, 2], totalCount: 10 })).toEqual({
			returned: 2,
			indicatedTotal: 10,
			hasMore: true,
		});
	});

	it('reports completeness when the page holds everything', () => {
		expect(deriveCompleteness({ items: [1, 2], total: 2 })?.hasMore).toBe(false);
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
	])('finds the collection under "%s"', (key) => {
		expect(deriveCompleteness({ [key]: [1], total: 5 })?.hasMore).toBe(true);
	});

	it.each([
		'total',
		'totalCount',
		'total_count',
		'totalItems',
		'totalResults',
		'count',
	])('finds the indicated total under "%s"', (key) => {
		expect(deriveCompleteness({ items: [1], [key]: 5 })?.hasMore).toBe(true);
	});

	// Inventing a signal from nothing would be a guess presented as a fact.
	it('stays silent when there is nothing to be incomplete about', () => {
		expect(deriveCompleteness({ items: [1, 2] })).toBeNull();
		expect(deriveCompleteness({ total: 5 })).toBeNull();
		expect(deriveCompleteness([1, 2, 3])).toBeNull();
		expect(deriveCompleteness('text')).toBeNull();
		expect(deriveCompleteness(null)).toBeNull();
	});
});

describe('withCompleteness', () => {
	it('stamps the signal onto a silently truncated body', () => {
		const out = withCompleteness({ items: [1, 2], totalCount: 10 });
		expect(out).toMatchObject({ hasMore: true, returned: 2, totalCount: 10 });
	});

	it('marks a full page as complete rather than leaving it ambiguous', () => {
		expect(withCompleteness({ items: [1, 2], total: 2 })).toMatchObject({ hasMore: false });
	});

	it.each([
		'hasMore',
		'nextCursor',
		'next_cursor',
		'incomplete',
		'truncated',
	])('defers to an upstream signal under "%s"', (key) => {
		const body = { items: [1], total: 50, [key]: 'upstream-value' };
		expect(withCompleteness(body)).toEqual(body);
	});

	// An upstream hasMore:false alongside a short page is the upstream's claim
	// to make. Deferring means we don't silently contradict it.
	it('does not treat a falsy upstream signal as authoritative', () => {
		const out = withCompleteness({ items: [1], total: 50, hasMore: false });
		expect(out).toMatchObject({ hasMore: true, returned: 1 });
	});

	it('returns non-collection bodies untouched', () => {
		const body = { sku: 'A1', price: 10 };
		expect(withCompleteness(body)).toEqual(body);
		expect(withCompleteness([1, 2])).toEqual([1, 2]);
		expect(withCompleteness('text')).toBe('text');
		expect(withCompleteness(null)).toBeNull();
	});

	it('preserves every existing field', () => {
		const out = withCompleteness({ items: [1], totalCount: 9, pageSize: 1, extra: 'keep' });
		expect(out).toMatchObject({ pageSize: 1, extra: 'keep', totalCount: 9 });
	});
});
