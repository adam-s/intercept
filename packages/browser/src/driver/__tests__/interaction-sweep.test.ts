/**
 * Pins for the sweep's plan and its refusals.
 *
 * The plan is pure, so ordering and coverage are checked directly. The refusals
 * matter more than the actions: this drives a real browser at somebody else's
 * site, and the cost of wrongly classifying a control as safe is a submitted
 * form, not a failed assertion.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
	DESTRUCTIVE,
	isDestructive,
	runSweep,
	SWEEP_LIMITS,
	sweepPlan,
} from '../interaction-sweep.js';
import {
	assertPageFunctionIsPortable,
	extractFunctionBody,
	findNestedFunctions,
} from '../page-function.js';
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

	/**
	 * Target-agnosticism, pinned structurally rather than by a denylist of sites.
	 *
	 * Listing the sites we happen to have run against proves nothing about the
	 * next one: the selector `.js-feed-item` names no site in that list and is
	 * still a bet on one codebase. What makes a selector portable is its
	 * vocabulary — standard element names and standard attributes are defined by
	 * HTML and ARIA, so they mean the same thing on a site nobody here has seen.
	 * A class or id selector means whatever one team decided last Tuesday.
	 */
	it('selects only on standard HTML and ARIA vocabulary', () => {
		const selectors = plan.map((a) => a.selector ?? '').join(',');
		expect(selectors).not.toMatch(/\.[a-zA-Z]/); // no class selectors
		expect(selectors).not.toMatch(/#[a-zA-Z]/); // no id selectors

		const STANDARD_ELEMENTS = [
			'input',
			'select',
			'video',
			'audio',
			'a',
			'article',
			'nav',
			'summary',
			'button',
			'form',
		];
		const STANDARD_ATTRS = /^(role|aria-[a-z]+|type|href|contenteditable|data-testid)$/;
		for (const part of selectors
			.split(',')
			.map((x) => x.trim())
			.filter(Boolean)) {
			for (const token of part.split(/\s+/)) {
				const element = token.match(/^([a-zA-Z]+)/)?.[1];
				if (element) expect(STANDARD_ELEMENTS).toContain(element);
				for (const attr of [...token.matchAll(/\[([a-zA-Z-]+)/g)].map((m) => m[1])) {
					expect(attr).toMatch(STANDARD_ATTRS);
				}
			}
		}
	});

	it('still names no site, which the vocabulary rule already implies', () => {
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

describe('label reading does not manufacture a refusal', () => {
	// A <button> with no type attribute reports `.type === 'submit'` by spec.
	// Reading the property put "submit" into the label of every plain button, so
	// the destructive check skipped all of them — the sweep refused to click
	// anything anywhere while reporting only that it had swept.
	it('does not treat a plain button as state-changing', () => {
		expect(isDestructive('Show chat')).toBe(false);
		expect(isDestructive('Load more')).toBe(false);
	});

	it('still refuses a button whose label really says submit', () => {
		expect(isDestructive('Submit review')).toBe(true);
	});

	// The label is built in the page, so this pins the contract the page function
	// must satisfy rather than the function itself.
	it('builds a label from attributes a plain button would not carry', () => {
		const plain = ['Show chat', null, null, null, null].filter(Boolean).join(' ');
		expect(isDestructive(plain)).toBe(false);
		const explicit = ['Save', null, null, null, 'submit'].filter(Boolean).join(' ');
		expect(isDestructive(explicit)).toBe(true);
	});
});

describe('no driver call can hang the sweep', () => {
	/**
	 * A hang is strictly worse than a failure: no output, no partial result,
	 * nothing to read, and a caller that waits forever. The action cap and the
	 * wall clock are only consulted *between* steps, so they bound a sweep that
	 * keeps returning and do nothing for one that stops returning — which is what
	 * happened, on a real page, with a stale handle after a form submission.
	 *
	 * So every driver round trip goes through `bounded`. This reads the source
	 * because the property is "no call site was missed", and a behavioural test
	 * can only cover the call sites it thought to exercise.
	 */
	const source = readFileSync(new URL('../interaction-sweep.ts', import.meta.url), 'utf8');
	const body = source.slice(source.indexOf('export async function runSweep'));

	it('routes every driver round trip through bounded()', () => {
		// The chain must be matched whole. An earlier version stopped at one level
		// of property access, so `p.keyboard.press(` was invisible to the check
		// written to find it — and unbounding that exact call stayed green.
		const unbounded = [...body.matchAll(/await\s+(p|h)\.((?:\w+\.)*\w+)\(/g)]
			// A timer cannot hang; everything else is a round trip to the browser.
			.filter((m) => m[2] !== 'waitForTimeout')
			.map((m) => `await ${m[1]}.${m[2]}(`);
		expect(unbounded).toEqual([]);
	});

	it('bounded() rejects rather than waiting forever', async () => {
		const { runSweep: _r } = await import('../interaction-sweep.js');
		expect(_r).toBeTypeOf('function');
		// A page whose every call never settles must still return a result.
		const stalled = {
			evaluate: () => new Promise(() => {}),
			waitForTimeout: async () => {},
			keyboard: { press: () => new Promise(() => {}), type: () => new Promise(() => {}) },
			$$: () => new Promise(() => {}),
			goto: () => new Promise(() => {}),
		} as unknown as DriverPage;
		const result = await runSweep(stalled, { dwellMs: 1, maxMs: 2_000 });
		expect(result.skipped.length).toBeGreaterThan(0);
	}, 60_000);
});

describe('page-bound functions survive the build', () => {
	/**
	 * The gate for the hazard in browser/driver/page-function. It reads the file
	 * on disk rather than the function object, because the runtime form is
	 * decided by whichever transpiler built the test: a `toString()` check stays
	 * green under Vitest even with the shipped build broken, which was confirmed
	 * by reintroducing the original defect and watching it pass.
	 */
	const source = readFileSync(new URL('../interaction-sweep.ts', import.meta.url), 'utf8');

	it('elementMeta contains no nested function', () => {
		expect(() => assertPageFunctionIsPortable(source, 'elementMeta')).not.toThrow();
	});

	it('rejects the nested arrow that caused the outage', () => {
		const broken = source.replace(
			'const label = [',
			"const attr = (n: string) => el.getAttribute(n) || '';\n\tconst label = [",
		);
		expect(broken).not.toEqual(source);
		expect(() => assertPageFunctionIsPortable(broken, 'elementMeta')).toThrow(/nested arrow/);
	});

	it('fails loudly when the function is renamed rather than skipping it', () => {
		expect(() => assertPageFunctionIsPortable(source, 'noSuchFunction')).toThrow(/was not found/);
	});

	it('reads through comments, so prose about arrows is not code', () => {
		expect(findNestedFunctions('// mentions => an arrow')).toEqual([]);
		expect(findNestedFunctions('const f = () => 1;')).toEqual(['arrow function']);
	});

	// Extraction that silently grabbed the return-type annotation instead of the
	// body would report every function as clean, which is the failure mode this
	// whole module exists to remove one level down.
	it('extracts the body itself, not the return type beside it', () => {
		const body = extractFunctionBody(source, 'elementMeta');
		expect(body).toContain('getAttribute');
		expect(extractFunctionBody('function f(x): { a: string } { return q; }', 'f')).toBe(
			' return q; ',
		);
	});
});
