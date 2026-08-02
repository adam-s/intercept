/**
 * FingerprintController
 *
 * Applies baseline anti-detection to the remote browser:
 * - Minimal init script: removes webdriver, sets realistic platform/vendor
 * - User-Agent and sec-ch-ua headers that stay in sync
 * - Tracking/fingerprinting URL blocklist
 *
 * This is the generic baseline applied to ALL browser sessions.
 * Profile-aware fingerprint customisation (persona WebGL, screen, fonts, etc.)
 * is handled by domain plugins (e.g. domains/chatgpt) via ChatGPTScriptInterceptor
 * and buildChatGPTFingerprintScript — those are domain-specific.
 *
 * The init script is installed via raw CDP (Page.addScriptToEvaluateOnNewDocument)
 * through CdpScriptControl, NOT via Patchright's addInitScript wrapper. This
 * matters for hostile detection (Cloudflare Turnstile / ChatGPT Sentinel) that
 * inspects the JS environment for automation tells.
 *
 * Usage:
 *   const fp = new FingerprintController();
 *   await fp.applyToContext(context, control); // headers + URL blocklist + CDP init script
 *   await fp.logFingerprint(page);             // log key fields for debugging
 */

import type { BrowserContext, Page } from 'patchright';
import type { CdpScriptControl, InitScriptHandle } from './cdp-script-control';

// Chrome 145 — version must match the sec-ch-ua header below.
const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * Minimal baseline anti-detection script.
 * Removes the `webdriver` flag and sets realistic navigator properties.
 * Domain plugins layer their own profile-aware script on top of this.
 */
const BASELINE_SCRIPT = `(function() {
	// Set a DOM attribute as an installation marker. The DOM is shared
	// across JS worlds, so it survives Patchright's isolated-world evaluator
	// (window/navigator overrides are NOT visible there because isolated
	// worlds get their own copies of those bindings).
	try { if (document && document.documentElement) document.documentElement.setAttribute('data-fp-baseline-ran', '1'); } catch(e) {}
	Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
	Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
	Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });
	Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
	Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
	Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
	Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
	Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
	const _origQuery = navigator.permissions?.query;
	if (_origQuery) {
		navigator.permissions.query = function(p) {
			if (p.name === 'notifications') return Promise.resolve({ state: 'denied', onchange: null });
			return _origQuery.call(this, p);
		};
	}
})();`;

/**
 * URLs to block completely (tracking, analytics, fingerprinting).
 * Domain-specific trackers that can detect automation.
 *
 * ⚠️  Do not remove entries without testing against bot-protected sites.
 */
const BLOCKED_TRACKING_URLS = [
	// Fingerprinting / device detection - CRITICAL for bot detection
	'**/fingerprintjs.com/**',
	'**/fpjs.io/**',
	'**/cdn.fingerprint.com/**',
	'**/arkoselabs.com/**',
	'**/funcaptcha.com/**',

	// Analytics & tracking
	'**/segment.io/**',
	'**/segment.com/**',
	'**/cdn.segment.com/**',
	'**/api.segment.io/**',

	// Marketing / attribution
	'**/branch.io/**',
	'**/app.link/**',
	'**/bnc.lt/**',
	'**/adjust.com/**',
	'**/appsflyer.com/**',

	// Error tracking (can leak automation info)
	'**/sentry.io/**',
	'**/bugsnag.com/**',

	// Analytics services
	'**/google-analytics.com/**',
	'**/googletagmanager.com/**',
	'**/gtag/**',

	// Social tracking pixels
	'**/facebook.com/tr/**',
	'**/connect.facebook.net/**',

	// Other trackers
	'**/doubleclick.net/**',
	'**/hotjar.com/**',
	'**/fullstory.com/**',
	'**/heap.io/**',
	'**/amplitude.com/**',
	'**/mixpanel.com/**',
	'**/optimizely.com/**',
	'**/launchdarkly.com/**',
] as const;

export class FingerprintController {
	/** The baseline anti-detection init script. */
	readonly script: string = BASELINE_SCRIPT;

	/** User-Agent string. */
	readonly userAgent: string = DEFAULT_USER_AGENT;

	/**
	 * sec-ch-ua client hint headers — must stay in sync with userAgent.
	 * When Patchright runs headless, Chromium sets sec-ch-ua to include
	 * "HeadlessChrome" — a primary Cloudflare Bot Management detection signal.
	 */
	readonly clientHintHeaders: Record<string, string> = {
		'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"macOS"',
	};

	/** Tracking/fingerprinting URL patterns to block at the context route level. */
	readonly blockedUrls: readonly string[] = BLOCKED_TRACKING_URLS;

	/** Handle to the installed CDP init script — used for cleanup if needed. */
	private installedHandle: InitScriptHandle | null = null;

	/**
	 * Apply all fingerprint protections to a browser context:
	 * - Registers the anti-detection init script via raw CDP (covers all
	 *   current and future pages, propagates to cross-origin subframes)
	 * - Sets sec-ch-ua client hint headers
	 * - Blocks tracking/fingerprinting URLs
	 *
	 * `control` MUST already be attached to (context, primaryPage). Call
	 * immediately after context creation, before any meaningful navigation.
	 */
	async applyToContext(context: BrowserContext, control: CdpScriptControl): Promise<void> {
		this.installedHandle = await control.registerInitScript(this.script);
		await context.setExtraHTTPHeaders(this.clientHintHeaders);

		// Block fingerprinting and tracking URLs at the route level.
		// This runs BEFORE Ghostery and catches domain-specific trackers.
		// We keep this on Patchright's context.route — these requests are
		// strictly aborted (no body fetch), so the route artifact is harmless.
		for (const pattern of this.blockedUrls) {
			await context.route(pattern, (route) => route.abort());
		}
	}

	/**
	 * Returns the installed init-script handle, if any. Used for cleanup
	 * during context teardown.
	 */
	getInstalledHandle(): InitScriptHandle | null {
		return this.installedHandle;
	}

	/**
	 * Log key browser fingerprint fields for debugging bot detection issues.
	 * Only call once per browser start — not on every page load.
	 */
	async logFingerprint(page: Page): Promise<void> {
		try {
			const fingerprint = await page.evaluate(() => {
				return {
					userAgent: navigator.userAgent,
					platform: navigator.platform,
					vendor: navigator.vendor,
					language: navigator.language,
					languages: navigator.languages,
					hardwareConcurrency: navigator.hardwareConcurrency,
					deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
					maxTouchPoints: navigator.maxTouchPoints,
					webdriver: (navigator as unknown as { webdriver?: boolean }).webdriver,
					screenWidth: screen.width,
					screenHeight: screen.height,
					screenColorDepth: screen.colorDepth,
					devicePixelRatio: window.devicePixelRatio,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					timezoneOffset: new Date().getTimezoneOffset(),
					webglVendor: (() => {
						try {
							const canvas = document.createElement('canvas');
							const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
							if (gl) {
								const dbg = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
								if (dbg)
									return (gl as WebGLRenderingContext).getParameter(dbg.UNMASKED_VENDOR_WEBGL);
							}
						} catch {
							/* ignore */
						}
						return 'unknown';
					})(),
					webglRenderer: (() => {
						try {
							const canvas = document.createElement('canvas');
							const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
							if (gl) {
								const dbg = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
								if (dbg)
									return (gl as WebGLRenderingContext).getParameter(dbg.UNMASKED_RENDERER_WEBGL);
							}
						} catch {
							/* ignore */
						}
						return 'unknown';
					})(),
				};
			});

			// Import logger dynamically to avoid circular deps
			const { browserLogger } = await import('./logger');
			browserLogger.lifecycle('fingerprint', {
				...fingerprint,
				nodeEnv: process.env.NODE_ENV,
				chromiumPath: process.env.CHROMIUM_PATH || 'bundled',
			});
		} catch (err) {
			// Don't fail browser start if fingerprint logging fails
			console.warn('[FingerprintController] Failed to log fingerprint:', err);
		}
	}
}
