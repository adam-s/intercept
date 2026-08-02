/**
 * Unit pins for waf-probe's scoring. No browser, no network — which is why
 * waf-probe.mjs guards its main flow to direct invocation.
 */

import { describe, expect, it } from 'vitest';
import {
	parseArgs,
	readLiveResult,
	readTurnstileResult,
	SCENARIOS,
	scoreFingerprint,
} from '../waf-probe.mjs';

describe('parseArgs', () => {
	it('probes both drivers and every scenario by default', () => {
		const o = parseArgs([]);
		expect(o.drivers).toEqual(['patchright', 'camoufox']);
		expect(o.scenarios).toEqual(Object.keys(SCENARIOS));
	});

	it('reads the uniform flags', () => {
		expect(
			parseArgs(['--drivers=camoufox', '--scenarios=fingerprint', '--headless=false']),
		).toMatchObject({
			drivers: ['camoufox'],
			scenarios: ['fingerprint'],
			headless: false,
		});
	});
});

describe('scoreFingerprint', () => {
	const clean = {
		userAgent: 'Mozilla/5.0 (Macintosh) Chrome/145.0.0.0 Safari/537.36',
		webdriver: false,
		webglRenderer: 'ANGLE (Apple, Apple M3 Pro)',
		pluginCount: 5,
		languages: ['en-US', 'en'],
		cdcArtifacts: [],
	};

	it('scores a clean stack at zero', () => {
		expect(scoreFingerprint(clean)).toEqual({ tells: [], score: 0 });
	});

	// Each of these is a tell a real detector reads. Measured 2026-07-28: the
	// headless UA marker was the only one this stack presented.
	it.each([
		['navigator.webdriver', { webdriver: true }],
		['headless UA', { userAgent: 'Mozilla/5.0 HeadlessChrome/145.0.0.0' }],
		['software WebGL', { webglRenderer: 'Google SwiftShader' }],
		['no plugins', { pluginCount: 0 }],
		['no languages', { languages: [] }],
		['CDP artifacts', { cdcArtifacts: ['cdc_adoQpoasnfa76pfcZLmcfl_Array'] }],
	])('flags %s', (_name, override) => {
		const r = scoreFingerprint({ ...clean, ...override });
		expect(r.score).toBe(1);
		expect(r.tells).toHaveLength(1);
	});

	it('counts tells cumulatively so two stacks can be ranked', () => {
		expect(scoreFingerprint({ ...clean, webdriver: true, pluginCount: 0 }).score).toBe(2);
	});

	it('treats llvmpipe and Mesa as software renderers too', () => {
		expect(scoreFingerprint({ ...clean, webglRenderer: 'llvmpipe (LLVM 15)' }).score).toBe(1);
		expect(scoreFingerprint({ ...clean, webglRenderer: 'Mesa OffScreen' }).score).toBe(1);
	});
});

describe('readTurnstileResult', () => {
	it('reports a blocked script distinctly from an absent widget', () => {
		expect(readTurnstileResult({ apiScriptLoaded: false }).verdict).toBe('script-blocked');
		expect(readTurnstileResult({ apiScriptLoaded: true, widgetRendered: false }).verdict).toBe(
			'widget-absent',
		);
	});

	it('reports a token when one was issued', () => {
		const r = readTurnstileResult({
			apiScriptLoaded: true,
			widgetRendered: true,
			token: 'XXXX.DUMMY.TOKEN.XXXX',
		});
		expect(r.verdict).toBe('token-issued');
		expect(r.detail).toContain('21');
	});

	it('distinguishes a rendered widget that issued nothing', () => {
		expect(
			readTurnstileResult({ apiScriptLoaded: true, widgetRendered: true, token: null }).verdict,
		).toBe('no-token');
	});
});

describe('readLiveResult', () => {
	it.each([
		'Just a moment...',
		'Checking your browser',
		'Attention Required',
		'Verify you are human',
		'Pardon Our Interruption',
	])('reads "%s" as challenged', (title) => {
		expect(readLiveResult({ title, bodySample: '', status: 200, textLength: 50 }).verdict).toBe(
			'challenged',
		);
	});

	// Regression: a short page is not a block. nowsecure.nl's success page is
	// 43 characters, and an earlier length threshold called it suspicious.
	it('passes a deliberately minimal success page', () => {
		const r = readLiveResult({
			title: 'nowsecure.nl',
			bodySample: 'NOWSECURE BY NODRIVER',
			status: 200,
			textLength: 43,
		});
		expect(r.verdict).toBe('passed');
	});

	it('passes an ordinary page', () => {
		expect(
			readLiveResult({
				title: 'DataDome',
				bodySample: 'Bot protection',
				status: 200,
				textLength: 9476,
			}).verdict,
		).toBe('passed');
	});

	it('reports a hard block by status', () => {
		expect(
			readLiveResult({ title: 'x', bodySample: 'y', status: 403, textLength: 100 }).verdict,
		).toBe('blocked');
	});

	it('reports an empty render rather than calling it a pass', () => {
		expect(readLiveResult({ title: '', bodySample: '', status: 200, textLength: 0 }).verdict).toBe(
			'empty',
		);
	});

	// The marker check must win over the status check: Cloudflare serves its
	// interstitial with 200 as often as with 403.
	it('reads a 200 interstitial as challenged, not passed', () => {
		expect(
			readLiveResult({
				title: 'Just a moment...',
				bodySample: '',
				status: 200,
				textLength: 2000,
			}).verdict,
		).toBe('challenged');
	});
});

describe('scenario list', () => {
	// The target list is fixed by design — see the SCOPE block in waf-probe.mjs.
	it('names every target and marks the live ones', () => {
		expect(Object.keys(SCENARIOS)).toContain('fingerprint');
		for (const [name, s] of Object.entries(SCENARIOS)) {
			expect(s.url.startsWith('https://'), `${name} must be https`).toBe(true);
			expect(s.description.length).toBeGreaterThan(10);
		}
	});
});
