/**
 * Unit pins for snapshot's pure helpers. No browser, no server — which is why
 * snapshot.mjs guards its main flow to direct invocation.
 */

import { describe, expect, it } from 'vitest';
import {
	DEFAULT_STATES,
	parseArgs,
	resolveStates,
	selectWork,
	shotName,
	VIEWPORTS,
} from '../snapshot.mjs';

const STATES = [
	{ name: 'home', path: '/' },
	{ name: 'detail', path: '/item/1' },
	{ name: 'search', path: '/search?q=a' },
];
const VIEWPORT_NAMES = Object.keys(VIEWPORTS);

describe('parseArgs', () => {
	it('applies the documented defaults', () => {
		expect(parseArgs([])).toMatchObject({
			label: 'latest',
			scenarios: null,
			viewports: null,
			headless: true,
			budget: 24,
			port: 3000,
		});
	});

	it('reads the uniform flags', () => {
		const o = parseArgs([
			'--label=before',
			'--scenarios=home,detail',
			'--viewports=mobile',
			'--headless=false',
		]);
		expect(o).toMatchObject({
			label: 'before',
			scenarios: ['home', 'detail'],
			viewports: ['mobile'],
			headless: false,
		});
	});

	it('treats --headless as true unless explicitly false', () => {
		expect(parseArgs(['--headless']).headless).toBe(true);
		expect(parseArgs(['--headless=true']).headless).toBe(true);
		expect(parseArgs(['--headless=false']).headless).toBe(false);
	});
});

describe('selectWork', () => {
	it('crosses every state with every viewport by default', () => {
		const { work } = selectWork(STATES, VIEWPORT_NAMES, { scenarios: null, viewports: null });
		expect(work).toHaveLength(STATES.length * VIEWPORT_NAMES.length);
	});

	it('narrows to the selected states and viewports', () => {
		const { work } = selectWork(STATES, VIEWPORT_NAMES, {
			scenarios: ['home'],
			viewports: ['mobile', 'desktop'],
		});
		expect(work).toHaveLength(2);
		expect(work.every((w) => w.state.name === 'home')).toBe(true);
	});

	// A typo'd name silently capturing nothing is the failure mode worth
	// pinning: the run would report success over an empty set.
	it('surfaces unknown names instead of silently dropping them', () => {
		const r = selectWork(STATES, VIEWPORT_NAMES, {
			scenarios: ['home', 'nope'],
			viewports: ['mobile', 'huge'],
		});
		expect(r.unknownStates).toEqual(['nope']);
		expect(r.unknownViewports).toEqual(['huge']);
		expect(r.work).toHaveLength(1);
	});

	it('returns no work when the selection matches nothing', () => {
		const { work } = selectWork(STATES, VIEWPORT_NAMES, { scenarios: ['nope'], viewports: null });
		expect(work).toEqual([]);
	});
});

describe('shotName', () => {
	it('is stable so two runs diff cleanly', () => {
		expect(shotName('home', 'mobile')).toBe('home--mobile.png');
		expect(shotName('home', 'mobile')).toBe(shotName('home', 'mobile'));
	});
});

describe('defaults', () => {
	it('ships the three viewports the layout branches on', () => {
		expect(Object.keys(VIEWPORTS)).toEqual(['mobile', 'tablet', 'desktop']);
		for (const v of Object.values(VIEWPORTS)) {
			expect(v.width).toBeGreaterThan(0);
			expect(v.height).toBeGreaterThan(0);
		}
	});

	it('has at least one default state so a bare run captures something', () => {
		expect(DEFAULT_STATES.length).toBeGreaterThan(0);
		for (const s of DEFAULT_STATES) {
			expect(s).toHaveProperty('name');
			expect(s.path.startsWith('/')).toBe(true);
		}
	});
});

describe('resolveStates', () => {
	const readFile = () => [{ name: 'fromFile', path: '/f' }];

	it('uses DEFAULT_STATES with neither flag', () => {
		expect(resolveStates({ path: null, states: null }, readFile)).toEqual(DEFAULT_STATES);
	});

	it('reads the states file when given', () => {
		expect(resolveStates({ path: null, states: 'x.json' }, readFile)).toEqual([
			{ name: 'fromFile', path: '/f' },
		]);
	});

	it('lets --path win over --states, and never reads the file', () => {
		let read = false;
		const states = resolveStates({ path: '/dashboard', states: 'x.json' }, () => {
			read = true;
			return [];
		});
		expect(states).toEqual([{ name: 'page', path: '/dashboard' }]);
		expect(read).toBe(false);
	});
});
