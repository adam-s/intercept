import { describe, expect, it, vi } from 'vitest';
import {
	buildLaunchConfig,
	camoufoxDriver,
	defaultPersonaOs,
	resolveHeadless,
} from '../camoufox-driver.js';
import {
	captureDecision,
	header,
	isDataContentType,
	isTelemetry,
	parseBody,
} from '../capture-filter.js';
import { DEFAULT_DRIVER, getDriver, listDrivers, requireDriver } from '../index.js';
import { patchrightDriver, stripHeadlessMarker } from '../patchright-driver.js';
import { startTrafficCapture } from '../traffic-capture.js';

describe('capture filter', () => {
	it('keeps API data', () => {
		expect(
			captureDecision({
				url: 'https://x.test/api/items',
				resourceType: 'xhr',
				contentType: 'application/json',
			}),
		).toEqual({ capture: true });
	});

	it.each([
		[
			'a stylesheet',
			{ url: 'https://x.test/a.css', resourceType: 'stylesheet', contentType: 'text/css' },
		],
		['an image', { url: 'https://x.test/a.png', resourceType: 'image', contentType: 'image/png' }],
		['a document', { url: 'https://x.test/', resourceType: 'document', contentType: 'text/html' }],
		['a font', { url: 'https://x.test/a.woff2', resourceType: 'font', contentType: 'font/woff2' }],
	])('drops %s with a reason', (_name, input) => {
		const d = captureDecision(input);
		expect(d.capture).toBe(false);
		expect(d.capture === false && d.reason).toBeTruthy();
	});

	it.each([
		'https://www.google-analytics.com/collect',
		'https://browser.sentry.io/api/1/envelope',
		'https://stats.g.doubleclick.net/j/collect',
		'https://api.amplitude.com/2/httpapi',
	])('drops telemetry: %s', (url) => {
		expect(
			captureDecision({ url, resourceType: 'xhr', contentType: 'application/json' }).capture,
		).toBe(false);
	});

	it('drops telemetry even when it looks like a data request', () => {
		expect(isTelemetry('https://sentry.io/api/x')).toBe(true);
		expect(isTelemetry('https://x.test/api/items')).toBe(false);
	});

	// A missing content-type must not silently drop a response — some APIs
	// omit it, and dropping them would read as "this transport is absent".
	it('keeps a response with no content-type', () => {
		expect(isDataContentType('')).toBe(true);
		expect(captureDecision({ url: 'https://x.test/api', resourceType: 'fetch' }).capture).toBe(
			true,
		);
	});

	it('reads headers regardless of casing', () => {
		expect(header({ 'Content-Type': 'application/json' }, 'content-type')).toBe('application/json');
		expect(header({ 'content-type': 'text/html' }, 'Content-Type')).toBe('text/html');
		expect(header(undefined, 'content-type')).toBe('');
	});

	it('parses JSON bodies and preserves everything else', () => {
		expect(parseBody('{"a":1}')).toEqual({ a: 1 });
		expect(parseBody('not json')).toBe('not json');
		expect(parseBody('')).toBe('');
		expect(parseBody(null)).toBeNull();
		expect(parseBody(undefined)).toBeNull();
	});
});

describe('driver registry', () => {
	it('registers both engines and defaults to the proven one', () => {
		expect(listDrivers().sort()).toEqual(['camoufox', 'patchright']);
		expect(DEFAULT_DRIVER).toBe('patchright');
		expect(getDriver().kind).toBe('patchright');
	});

	// Silently falling back would make every later bot-protection result
	// meaningless, because the wrong engine would have produced it.
	it('throws on an unknown kind rather than falling back', () => {
		expect(() => getDriver('chrome' as never)).toThrow(/Unknown browser driver/);
	});

	it('requireDriver reports a missing engine before any target is touched', async () => {
		const spy = vi
			.spyOn(camoufoxDriver, 'isAvailable')
			.mockResolvedValue({ available: false, reason: 'camoufox-js is not installed' });
		try {
			await expect(requireDriver('camoufox')).rejects.toThrow(/is not available.*not installed/s);
		} finally {
			spy.mockRestore();
		}
	});

	it('requireDriver returns the driver when its engine is present', async () => {
		const spy = vi.spyOn(camoufoxDriver, 'isAvailable').mockResolvedValue({ available: true });
		try {
			expect((await requireDriver('camoufox')).kind).toBe('camoufox');
		} finally {
			spy.mockRestore();
		}
	});
});

describe('driver capabilities are declared, not assumed', () => {
	it('patchright has CDP and an isolated evaluate world', () => {
		expect(patchrightDriver.capabilities).toMatchObject({
			cdp: true,
			isolatedEvaluateWorld: true,
			engineLevelFingerprint: false,
		});
	});

	it('camoufox has no CDP, an engine-level fingerprint, and the page world', () => {
		expect(camoufoxDriver.capabilities).toMatchObject({
			cdp: false,
			isolatedEvaluateWorld: false,
			engineLevelFingerprint: true,
			pinnableOs: true,
			trueHeadless: false,
		});
	});

	it('the two engines disagree on every capability that decides which to use', () => {
		for (const key of ['cdp', 'engineLevelFingerprint', 'isolatedEvaluateWorld'] as const) {
			expect(patchrightDriver.capabilities[key]).not.toBe(camoufoxDriver.capabilities[key]);
		}
	});
});

describe('camoufox launch configuration', () => {
	it('maps the host platform to a persona OS', () => {
		expect(defaultPersonaOs('darwin')).toBe('macos');
		expect(defaultPersonaOs('win32')).toBe('windows');
		expect(defaultPersonaOs('linux')).toBe('linux');
	});

	// True headless trips Cloudflare on any engine. A refusal is debuggable;
	// an unexplained challenge is not.
	it('refuses true headless off Linux instead of running a mode that fails', () => {
		expect(() => resolveHeadless(true, 'darwin')).toThrow(/refuses true headless/);
	});

	it('uses the virtual display on Linux', () => {
		expect(resolveHeadless(true, 'linux')).toBe('virtual');
		expect(resolveHeadless(undefined, 'linux')).toBe('virtual');
	});

	it('runs headed elsewhere', () => {
		expect(resolveHeadless(false, 'darwin')).toBe(false);
		expect(resolveHeadless(undefined, 'darwin')).toBe(false);
	});

	// An unpinned persistent profile invalidates its own clearance cookie on
	// every launch, which is the subtle failure this default prevents.
	it('pins the persona OS whenever a profile persists', () => {
		const config = buildLaunchConfig({ profileDir: '/tmp/p' }, 'darwin');
		expect(config.os).toBe('macos');
		expect(config.persistent_context).toBe(true);
		expect(config.user_data_dir).toBe('/tmp/p');
	});

	it('leaves the persona unpinned for an ephemeral session, so each is fresh', () => {
		expect(buildLaunchConfig({}, 'darwin').os).toBeUndefined();
	});

	it('honors an explicit OS pin over the host default', () => {
		expect(buildLaunchConfig({ os: 'windows' }, 'darwin').os).toBe('windows');
	});

	it('never emits headless true', () => {
		for (const host of ['darwin', 'linux', 'win32']) {
			const requested = host === 'linux' ? true : undefined;
			expect(buildLaunchConfig({ headless: requested }, host).headless).not.toBe(true);
		}
	});
});

describe('traffic capture', () => {
	/** A page double that emits the Playwright events the capture path listens on. */
	function fakePage() {
		const handlers = new Map<string, (arg: unknown) => void>();
		return {
			page: { on: (event: string, fn: (arg: unknown) => void) => handlers.set(event, fn) },
			emit: (event: string, arg: unknown) => handlers.get(event)?.(arg),
			has: (event: string) => handlers.has(event),
		};
	}

	const response = (over: Record<string, unknown> = {}) => ({
		url: () => 'https://x.test/api/items',
		status: () => 200,
		headers: () => ({ 'content-type': 'application/json' }),
		body: async () => Buffer.from('{"items":[1]}'),
		request: () => ({
			url: () => 'https://x.test/api/items',
			method: () => 'GET',
			resourceType: () => 'xhr',
			postData: () => null,
			headers: () => ({ accept: 'application/json' }),
		}),
		...over,
	});

	it('listens for both HTTP responses and WebSockets', () => {
		const { page, has } = fakePage();
		startTrafficCapture(page as never, () => {});
		expect(has('response')).toBe(true);
		expect(has('websocket')).toBe(true);
	});

	it('captures an XHR with its parsed body', async () => {
		const { page, emit } = fakePage();
		const seen: unknown[] = [];
		startTrafficCapture(page as never, (req, res) => seen.push({ req, res }));
		emit('response', response());
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toMatchObject({
			req: { method: 'GET' },
			res: { status: 200, body: { items: [1] } },
		});
	});

	it('skips a body it cannot read rather than recording it as empty', async () => {
		const { page, emit } = fakePage();
		const seen: unknown[] = [];
		startTrafficCapture(page as never, (...a) => seen.push(a));
		emit(
			'response',
			response({
				body: async () => {
					throw new Error('no body for redirect');
				},
			}),
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(seen).toEqual([]);
	});

	it('stops capturing once the returned stop function is called', async () => {
		const { page, emit } = fakePage();
		const seen: unknown[] = [];
		const stop = startTrafficCapture(page as never, (...a) => seen.push(a));
		stop();
		emit('response', response());
		await new Promise((r) => setTimeout(r, 20));
		expect(seen).toEqual([]);
	});

	it('captures WebSocket creation and frames in both directions', async () => {
		const { page, emit } = fakePage();
		const seen: Array<{ method: string; body: unknown }> = [];
		startTrafficCapture(page as never, (req, res) =>
			seen.push({ method: req.method, body: res.body }),
		);

		const wsHandlers = new Map<string, (p: string) => void>();
		emit('websocket', {
			url: () => 'wss://x.test/live',
			on: (event: string, fn: (p: string) => void) => wsHandlers.set(event, fn),
		});
		wsHandlers.get('framereceived')?.('{"tick":1}');
		wsHandlers.get('framesent')?.('{"sub":"a"}');

		expect(seen.map((s) => s.method)).toEqual(['WS', 'WS-FRAME', 'WS-FRAME']);
		expect(seen[1].body).toMatchObject({ direction: 'received', data: { tick: 1 } });
		expect(seen[2].body).toMatchObject({ direction: 'sent', data: { sub: 'a' } });
	});
});

describe('camoufox version coupling', () => {
	// A camoufox build matches one playwright-core range, and a mismatch
	// surfaces as a Juggler protocol error at launch, not a version error.
	// Verified 2026-07-28: camoufox v152 + playwright-core 1.62 fails with
	// "Found property <root>.viewport.isMobile ... not described in this
	// scheme"; 1.53.1 works. This pins the version that was actually proven.
	it('pins playwright-core to the version proven against the installed camoufox build', async () => {
		const { createRequire } = await import('node:module');
		const require = createRequire(import.meta.url);
		const installed = require('playwright-core/package.json').version;
		const declared = require('../../../package.json').dependencies['playwright-core'];

		expect(declared, 'playwright-core must be pinned exactly, not ranged').toMatch(
			/^\d+\.\d+\.\d+$/,
		);
		expect(installed).toBe(declared);
	});
});

describe('headless UA marker', () => {
	// Measured 2026-07-28: headless Chromium reports
	// "HeadlessChrome/145.0.0.0", the one automation tell this stack still
	// presented. Stripping it yields the headed build's real UA.
	it('rewrites the headless token to the headed one', () => {
		expect(
			stripHeadlessMarker(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.0.0 Safari/537.36',
			),
		).toBe(
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
		);
	});

	it('leaves an already-headed UA untouched', () => {
		const ua = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36';
		expect(stripHeadlessMarker(ua)).toBe(ua);
	});

	it('leaves no trace of the marker anywhere in the string', () => {
		expect(stripHeadlessMarker('HeadlessChrome/1 HeadlessChrome/2')).not.toMatch(/headless/i);
	});
});
