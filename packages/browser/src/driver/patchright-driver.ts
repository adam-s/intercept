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

		// An empty userDataDir gives Chromium a throwaway profile, so one call
		// covers both the persistent and ephemeral cases.
		const context = await chromium.launchPersistentContext(profileDir ?? '', {
			headless,
			channel: 'chromium',
			args: ['--disable-blink-features=AutomationControlled', ...args],
			// Headless Chromium advertises itself in the user agent
			// ("HeadlessChrome/145.0.0.0") — measured 2026-07-28 by
			// scripts/waf-probe.mjs, and the single automation tell this stack
			// still presents. Nothing else has to look for it: the string is
			// right there in navigator.userAgent. Strip the marker so the UA
			// matches the headed build it otherwise is.
			...(headless ? { userAgent: await headedUserAgent(chromium) } : {}),
			...(timeout ? { timeout } : {}),
		});

		return new PatchrightSession(context as never);
	},
};
