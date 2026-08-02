/**
 * Unit pins for snapshot's pure helpers. No browser, no server — which is why
 * snapshot.mjs guards its main flow to direct invocation.
 */

import { describe, expect, it } from 'vitest';
import {
	CHALLENGE_TEXT_CEILING,
	DEFAULT_STATES,
	detectRenderedChallenge,
	NEUTRAL_WARM,
	parseArgs,
	resolveOrigin,
	resolveStates,
	selectWork,
	shotName,
	VIEWPORTS,
	warmChainFor,
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
			origin: null,
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

describe('resolveOrigin', () => {
	it('defaults to the local web app on --port', () => {
		expect(resolveOrigin({ origin: null, port: 3000 })).toBe('http://localhost:3000');
		expect(resolveOrigin({ origin: null, port: 3041 })).toBe('http://localhost:3041');
	});

	it('lets --origin win over --port, so a frame can come from a live site', () => {
		expect(resolveOrigin({ origin: 'https://example.com', port: 3000 })).toBe(
			'https://example.com',
		);
	});

	it('strips trailing slashes, because every state path carries a leading one', () => {
		expect(resolveOrigin({ origin: 'https://example.com/', port: 3000 })).toBe(
			'https://example.com',
		);
		expect(resolveOrigin({ origin: 'https://example.com///', port: 3000 })).toBe(
			'https://example.com',
		);
	});
});

describe('detectRenderedChallenge', () => {
	// Verbatim from .snapshots/frame-1-reddit, 2026-07-29: reddit served this to
	// a cold headless session while /api/reddit/popular returned real posts.
	const REDDIT_WALL =
		"You've been blocked by network security.\n" +
		"If you think you've been blocked by mistake, file a ticket below and we'll look into it.\n" +
		'File a ticket';

	it('names the interstitial that replaced the page', () => {
		expect(detectRenderedChallenge({ title: 'Blocked', text: REDDIT_WALL })).toBe(
			'generic-network-block',
		);
		expect(
			detectRenderedChallenge({ text: 'Checking your browser before accessing example.com' }),
		).toBe('cloudflare');
		expect(
			detectRenderedChallenge({ text: 'Verifying you are human. This may take a few seconds.' }),
		).toBe('generic-waf');
	});

	it('reads the title as well as the body', () => {
		expect(detectRenderedChallenge({ title: 'Attention Required! | Cloudflare', text: '' })).toBe(
			'cloudflare',
		);
	});

	// Regression: a marker list built from reddit's "blocked by network security"
	// wall let reddit's OWN second wall through, because it is worded differently.
	// Phrase lists generalize to the walls already seen; a widget host does not.
	it('catches a captcha by its widget, whatever the copy says', () => {
		const frameUrls = [
			'https://www.reddit.com/r/popular',
			'https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc',
		];
		expect(
			detectRenderedChallenge({ title: 'reddit', text: 'Prove your humanity', frameUrls }),
		).toBe('recaptcha');
	});

	it('catches a widget even under a page full of real text', () => {
		// No length ceiling on the widget signal — a captcha is a captcha however
		// much copy surrounds it, and a ceiling would reopen the hole.
		const long = 'lorem ipsum '.repeat(400);
		expect(
			detectRenderedChallenge({
				text: long,
				frameUrls: ['https://challenges.cloudflare.com/turnstile/v0/api.js'],
			}),
		).toBe('turnstile');
	});

	it('catches the wordings the first list missed', () => {
		for (const text of [
			'Prove your humanity',
			'Complete the challenge below',
			"let us know you're a real person",
			'Press & Hold to confirm',
		]) {
			expect(detectRenderedChallenge({ text })).toBe('generic-waf');
		}
	});

	it('ignores ordinary third-party iframes', () => {
		expect(
			detectRenderedChallenge({
				text: 'A normal page',
				frameUrls: ['https://www.youtube.com/embed/abc', 'https://platform.twitter.com/widget'],
			}),
		).toBe(null);
	});

	it('passes real content through', () => {
		expect(
			detectRenderedChallenge({ title: 'r/popular', text: 'Wrong to be annoyed? 2269 points' }),
		).toBe(null);
		expect(detectRenderedChallenge({})).toBe(null);
	});

	it('does not flag a page that merely writes about bot walls', () => {
		// The guard that matters: an interstitial is a near-empty page, so the
		// same phrase inside a page carrying real content is content.
		const article = `A history of bot walls. ${'lorem ipsum '.repeat(300)} Sites say "sorry, you have been blocked" when they refuse you.`;
		expect(article.length).toBeGreaterThan(CHALLENGE_TEXT_CEILING);
		expect(detectRenderedChallenge({ title: 'On bot walls', text: article })).toBe(null);
	});
});

describe('warmChainFor', () => {
	it('ends at the target origin, after neutral history', () => {
		const chain = warmChainFor('https://www.reddit.com');
		expect(chain.at(-1)).toBe('https://www.reddit.com');
		expect(chain.length).toBeGreaterThan(1);
	});

	it('reduces the origin to its root, so the last hop is a homepage', () => {
		expect(warmChainFor('https://www.reddit.com/r/popular?x=1').at(-1)).toBe(
			'https://www.reddit.com',
		);
	});

	// A persona whose entire history is one deep link reads as purpose-built, so
	// the neutral hops are the point rather than decoration.
	it('keeps the neutral hops when the origin cannot be parsed', () => {
		expect(warmChainFor('not-a-url')).toEqual(NEUTRAL_WARM);
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

	// A frame whose main region is still a spinner reads as a successful capture:
	// the PNG exists, the run exits 0, and the content that mattered never
	// arrived. --wait-for names the element that proves it did.
	it('carries --wait-for onto an ad-hoc --path capture', () => {
		expect(resolveStates({ path: '/x', states: null, waitFor: '[data-loaded]' }, () => [])).toEqual(
			[{ name: 'page', path: '/x', waitFor: '[data-loaded]' }],
		);
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
