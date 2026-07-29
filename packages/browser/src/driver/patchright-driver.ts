/**
 * Patchright Driver — Chromium
 *
 * The engine this framework grew up on, now behind the driver seam. Nothing
 * about its behavior changes; what changes is that callers reach it through an
 * interface a second engine can also satisfy.
 *
 * Retained deliberately while the Firefox path proves out. Introducing a new
 * engine and retiring the old one in the same change means a capture failure
 * has two possible causes and no way to tell which.
 *
 * @module browser/driver/patchright-driver
 */

import { platform } from 'node:os';
import { DEBUG } from '@interceptor/shared';
import { startTrafficCapture } from './traffic-capture.js';
import type {
	BrowserDriver,
	DriverCapabilities,
	DriverLaunchOptions,
	DriverPage,
	DriverSession,
	NetworkCaptureCallback,
} from './types.js';

const CAPABILITIES: DriverCapabilities = {
	cdp: true,
	// Spoofed from JavaScript over CDP: real, but reachable by page script,
	// which is the ceiling on this approach.
	engineLevelFingerprint: false,
	pinnableOs: false,
	trueHeadless: true,
	// Verified empirically 2026-07-28, and documented independently in
	// remote/cdp-script-control.ts: page.evaluate cannot see page globals.
	isolatedEvaluateWorld: true,
};

/**
 * Turn a headless Chromium user agent into the headed equivalent.
 *
 * Pure, and exported so a test can drive it without launching a browser.
 * Chromium's own headed build differs only by this token, so removing it
 * produces a real UA rather than an invented one.
 */
export function stripHeadlessMarker(userAgent: string): string {
	return userAgent.replace(/HeadlessChrome/g, 'Chrome');
}

/**
 * Chromium flags that remove the standard automation tells.
 *
 * Verified 2026-07-29 against live Twitch and YouTube, which both refused the
 * previous configuration and both render fully under this one. Matched to the
 * newest working implementation across these repos
 * (~/Projects/job-hunter-video/scripts/lib/patchright.mjs).
 */
export const HARDENED_ARGS = [
	'--disable-infobars',
	'--disable-blink-features=AutomationControlled',
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding',
	'--no-first-run',
	'--no-default-browser-check',
];

/**
 * Full launch args for a run, including the platform-conditional ones. Pure, so
 * a test pins the combination without launching anything.
 *
 * Headless macOS forces ANGLE/Metal because the headless default reports a
 * different WebGL renderer than the same machine reports headed, and that
 * mismatch is itself the signal. Measured: with the pin the renderer reads
 * "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)" in both modes.
 */
export function buildLaunchArgs(
	headless: boolean,
	extra: string[] = [],
	hostPlatform: string = platform(),
): string[] {
	return [
		...HARDENED_ARGS,
		...(headless && hostPlatform === 'darwin' ? ['--use-angle=metal'] : []),
		...extra,
	];
}

/**
 * Client-hint metadata matching a de-headlessed user agent.
 *
 * Setting `userAgent` alone is not enough: `navigator.userAgentData` is read
 * independently of the UA string and still reports the headless brand list, so
 * a stack that rewrites only the string advertises headless to anything that
 * looks at the hints. Both have to move together.
 */
export function headedUserAgentMetadata(userAgent: string) {
	const major = userAgent.split('Chrome/')[1]?.split('.')[0] ?? '145';
	return {
		platform: 'macOS',
		platformVersion: '15.0',
		architecture: 'arm',
		model: '',
		mobile: false,
		brands: [
			{ brand: 'Google Chrome', version: major },
			{ brand: 'Chromium', version: major },
			{ brand: 'Not)A;Brand', version: '24' },
		],
	};
}

/**
 * The UA this Chromium build would report if it were running headed.
 *
 * Read from the build rather than hardcoded: a pinned version string goes stale
 * on the next Chromium bump and becomes a tell of its own. The read costs one
 * throwaway launch, so it is memoized — the answer cannot change while the
 * process is running.
 */
let headedUaPromise: Promise<string> | null = null;

async function headedUserAgent(chromium: {
	launchPersistentContext(
		dir: string,
		opts: Record<string, unknown>,
	): Promise<{
		newPage(): Promise<{ evaluate(fn: () => string): Promise<string> }>;
		close(): Promise<void>;
	}>;
}): Promise<string> {
	headedUaPromise ??= (async () => {
		const probe = await chromium.launchPersistentContext('', {
			headless: true,
			channel: 'chromium',
		});
		try {
			const page = await probe.newPage();
			return stripHeadlessMarker(await page.evaluate(() => navigator.userAgent));
		} finally {
			await probe.close();
		}
	})();
	return headedUaPromise;
}

class PatchrightSession implements DriverSession {
	readonly kind = 'patchright' as const;
	readonly capabilities = CAPABILITIES;

	constructor(private readonly context: { newPage(): Promise<unknown>; close(): Promise<void> }) {}

	async newPage(): Promise<DriverPage> {
		return (await this.context.newPage()) as DriverPage;
	}

	async startTrafficCapture(
		page: DriverPage,
		onCapture: NetworkCaptureCallback,
	): Promise<() => void> {
		return startTrafficCapture(page, onCapture);
	}

	async close(): Promise<void> {
		await this.context.close();
	}
}

export const patchrightDriver: BrowserDriver = {
	kind: 'patchright',
	capabilities: CAPABILITIES,

	async isAvailable() {
		try {
			await import('patchright');
			return { available: true };
		} catch (err) {
			return { available: false, reason: `patchright is not installed: ${String(err)}` };
		}
	},

	async launch(options: DriverLaunchOptions = {}): Promise<DriverSession> {
		const { chromium } = await import('patchright');
		const { profileDir = null, headless = true, args = [], timeout } = options;

		DEBUG(
			'driver',
			`launching patchright (headless=${headless}, profile=${profileDir ?? 'ephemeral'})`,
		);

		const ua = headless ? await headedUserAgent(chromium) : null;

		// An empty userDataDir gives Chromium a throwaway profile, so one call
		// covers both the persistent and ephemeral cases.
		const context = await chromium.launchPersistentContext(profileDir ?? '', {
			headless,
			// Patchright's stealth patches live in its OWN bundled binary, which is
			// what 'chromium' selects. 'chrome' launches the system Google Chrome,
			// which patchright never patched — the call still reads as legitimate
			// for naming a real browser while every guarantee is silently gone.
			channel: 'chromium',
			args: buildLaunchArgs(headless, args),
			// Playwright adds --enable-automation by default, and it sets
			// navigator.webdriver regardless of the flags above.
			ignoreDefaultArgs: ['--enable-automation'],
			// Headless Chromium advertises itself in the user agent
			// ("HeadlessChrome/145.0.0.0") and, independently, in the sec-ch-ua
			// client hints. Rewriting only the string leaves the hints still
			// announcing headless, so both move together.
			...(ua ? { userAgent: ua, userAgentMetadata: headedUserAgentMetadata(ua) } : {}),
			...(timeout ? { timeout } : {}),
		});

		return new PatchrightSession(context as never);
	},
};
