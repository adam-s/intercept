/**
 * Pins for the sweep's plan and its refusals.
 *
 * The plan is pure, so ordering and coverage are checked directly. The refusals
 * matter more than the actions: this drives a real browser at somebody else's
 * site, and the cost of wrongly classifying a control as safe is a submitted
 * form, not a failed assertion.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	DESTRUCTIVE,
	isDestructive,
	runSweep,
	SWEEP_LIMITS,
	sweepPlan,
} from '../interaction-sweep.js';
import type { DriverPage } from '../types.js';

describe('sweepPlan', () => {
	const plan = sweepPlan();

	it('provokes every interaction-gated transport class we know to look for', () => {
		const kinds = new Set(plan.map((a) => a.kind));
		for (const k of ['dwell', 'scroll', 'type', 'click', 'hover', 'key']) {
			expect(kinds).toContain(k);
		}
	});

	// Sockets and polling only appear to something that waited, and a run that
	// exhausts its budget mid-plan must already have spent it on those.
	it('dwells first, so a truncated run still catches sockets and polling', () => {
		expect(plan[0].kind).toBe('dwell');
	});

	it('dwells again at the end, because a period needs two ticks to be visible', () => {
		expect(plan.filter((a) => a.kind === 'dwell').length).toBeGreaterThanOrEqual(2);
		expect(plan.at(-1)?.kind).toBe('dwell');
	});

	it('states why each provocation exists, so the list stays auditable', () => {
		for (const a of plan) expect(a.why.length).toBeGreaterThan(10);
	});

	it('is target-agnostic — no selector names a specific site', () => {
		const selectors = plan.map((a) => a.selector ?? '').join(' ');
		expect(selectors).not.toMatch(/twitch|reddit|youtube|yahoo|boardshop/i);
	});

	it('stays within its own action bound', () => {
		expect(plan.length).toBeLessThanOrEqual(SWEEP_LIMITS.maxActions);
	});
});

describe('isDestructive', () => {
	it.each([
		'Submit',
		'Delete post',
		'Log out',
		'Buy now',
		'Send message',
		'Report',
	])('refuses %s', (label) => {
		expect(isDestructive(label)).toBe(true);
	});

	it.each([
		'Next page',
		'Load more',
		'Videos',
		'About',
		'Comments',
		'Show replies',
	])('allows the read-only control %s', (label) => {
		expect(isDestructive(label)).toBe(false);
	});

	it('matches regardless of case', () => {
		expect(isDestructive('CHECKOUT')).toBe(true);
	});

	it('names every guarded word in one exported list, so the policy has one home', () => {
		expect(DESTRUCTIVE).toContain('delete');
		expect(new Set(DESTRUCTIVE).size).toBe(DESTRUCTIVE.length);
	});
});

/** Minimal page double: records calls, matches nothing unless told otherwise. */
function fakePage(over: Record<string, unknown> = {}) {
	const calls: string[] = [];
	const page = {
		evaluate: vi.fn(async (src: string) => {
			calls.push(`evaluate:${String(src).slice(0, 30)}`);
			if (String(src).includes('location.origin')) return 'https://x.test';
			if (String(src).includes('location.href')) return 'https://x.test/start';
			return undefined;
		}),
		waitForTimeout: vi.fn(async () => {
			calls.push('wait');
		}),
		keyboard: {
			press: vi.fn(async () => calls.push('press')),
			type: vi.fn(async () => calls.push('type')),
		},
		$$: vi.fn(async () => []),
		goto: vi.fn(async () => calls.push('goto')),
		calls,
		...over,
	};
	return page as unknown as DriverPage & { calls: string[] };
}

/** An element double whose label decides whether the sweep should touch it. */
function fakeEl(label: string, href = '') {
	const clicked = { count: 0 };
	return {
		handle: {
			evaluate: async () => ({ label, href }),
			click: async () => {
				clicked.count += 1;
			},
			hover: async () => {},
		},
		clicked,
	};
}

describe('runSweep', () => {
	it('records what it did and what it skipped', async () => {
		const page = fakePage();
		const result = await runSweep(page, { dwellMs: 1, maxMs: 5_000 });
		expect(result.performed.length).toBeGreaterThan(0);
		expect(result.skipped.some((s) => s.includes('no match'))).toBe(true);
	});

	it('does not click a control whose label reads as state-changing', async () => {
		const danger = fakeEl('Delete account');
		const page = fakePage({ $$: vi.fn(async () => [danger.handle]) });
		const result = await runSweep(page, { dwellMs: 1 });
		expect(danger.clicked.count).toBe(0);
		expect(result.skipped.some((s) => s.includes('state-changing'))).toBe(true);
	});

	// Following an off-origin link makes every later capture describe a different
	// site, which silently corrupts the manifest rather than failing.
	it('does not follow an off-origin link', async () => {
		const away = fakeEl('Sponsor', 'https://other.test/promo');
		const page = fakePage({ $$: vi.fn(async () => [away.handle]) });
		const result = await runSweep(page, { dwellMs: 1 });
		expect(away.clicked.count).toBe(0);
		expect(result.skipped.some((s) => s.includes('off-origin'))).toBe(true);
	});

	it('clicks a same-origin read-only control', async () => {
		const ok = fakeEl('Comments', '/thread/1');
		const page = fakePage({ $$: vi.fn(async () => [ok.handle]) });
		await runSweep(page, { dwellMs: 1 });
		expect(ok.clicked.count).toBeGreaterThan(0);
	});

	it('honours the per-selector cap instead of walking every match', async () => {
		const els = Array.from({ length: 20 }, () => fakeEl('Load more', '/more'));
		const page = fakePage({ $$: vi.fn(async () => els.map((e) => e.handle)) });
		await runSweep(page, { dwellMs: 1, maxPerSelector: 2 });
		expect(els.filter((e) => e.clicked.count > 0).length).toBeLessThanOrEqual(2);
	});

	it('stops at the action cap', async () => {
		const els = Array.from({ length: 50 }, () => fakeEl('More', '/m'));
		const page = fakePage({ $$: vi.fn(async () => els.map((e) => e.handle)) });
		const result = await runSweep(page, { dwellMs: 1, maxActions: 3 });
		expect(result.performed.length).toBeLessThanOrEqual(3);
	});

	it('returns to the start URL when a provocation navigated away', async () => {
		let href = 'https://x.test/start';
		const page = fakePage({
			evaluate: vi.fn(async (src: string) => {
				if (String(src).includes('location.origin')) return 'https://x.test';
				if (String(src).includes('location.href')) {
					const now = href;
					href = 'https://x.test/elsewhere';
					return now;
				}
				return undefined;
			}),
		});
		await runSweep(page, { dwellMs: 1 });
		expect(
			(page as unknown as { goto: { mock: { calls: unknown[] } } }).goto.mock.calls.length,
		).toBeGreaterThan(0);
	});

	// One detached element must not cost the remaining provocations.
	it('continues after an element throws', async () => {
		const bad = {
			evaluate: async () => {
				throw new Error('detached');
			},
		};
		const page = fakePage({ $$: vi.fn(async () => [bad]) });
		const result = await runSweep(page, { dwellMs: 1 });
		expect(result.performed.some((a) => a.kind === 'dwell')).toBe(true);
	});

	it('never exceeds its wall-clock ceiling', async () => {
		const page = fakePage();
		const started = Date.now();
		await runSweep(page, { dwellMs: 1, maxMs: 50 });
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
