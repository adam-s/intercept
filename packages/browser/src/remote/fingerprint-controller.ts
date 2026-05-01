/**
 * FingerprintController
 *
 * Encapsulates all anti-fingerprinting logic for the remote browser:
 * - The anti-detection init script (generated from a FingerprintProfile)
 * - The User-Agent and sec-ch-ua headers that must stay in sync
 * - Tracking/fingerprinting URL blocklist
 * - Fingerprint logging for debugging bot detection issues
 *
 * Usage:
 *   const fp = new FingerprintController(profile);
 *   await fp.applyToContext(context);  // sets headers + blocks URLs + registers context init script
 *   await fp.applyToPage(page);        // adds init script to an existing page (persistent context)
 *   await fp.logFingerprint(page);     // logs key fields for bot detection debugging
 */

import type { FingerprintProfile } from '@interceptor/shared';
import type { BrowserContext, Page } from 'patchright';
import { buildFingerprintScript } from '../fingerprint-script';

// Chrome 145 — version must match the sec-ch-ua header below.
// A mismatch between UA and sec-ch-ua is a bot detection signal.
const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

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
	'**/fp.boardshop.com/**',
	'**/arkoselabs.com/**',
	'**/funcaptcha.com/**',

	// Analytics & tracking
	'**/segment.io/**',
	'**/segment.com/**',
	'**/analytics.boardshop.com/**',
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
	/** The anti-detection init script generated from the active profile. */
	readonly script: string;

	/** User-Agent string — from profile if set, otherwise the default Mac Chrome UA. */
	readonly userAgent: string;

	/**
	 * sec-ch-ua client hint headers — must stay in sync with userAgent.
	 * Applied to every context via setExtraHTTPHeaders to prevent HeadlessChrome detection.
	 */
	readonly clientHintHeaders: Record<string, string> = {
		// Override sec-ch-ua to prevent HeadlessChrome detection.
		// When Patchright runs in headless mode, Chromium automatically sets
		// sec-ch-ua to include "HeadlessChrome" — a primary Cloudflare Bot Management
		// detection signal. The value must match userAgent version (Chrome 145).
		// When using real Chrome channel, sec-ch-ua is already correct — this is defense-in-depth.
		'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"macOS"',
	};

	/** Tracking/fingerprinting URL patterns to block at the context route level. */
	readonly blockedUrls: readonly string[] = BLOCKED_TRACKING_URLS;

	constructor(profile?: FingerprintProfile) {
		this.script = buildFingerprintScript(profile);
		this.userAgent = profile?.userAgent ?? DEFAULT_USER_AGENT;
	}

	/**
	 * Apply all fingerprint protections to a browser context:
	 * - Registers the anti-detection init script (for all future pages)
	 * - Sets sec-ch-ua client hint headers
	 * - Blocks tracking/fingerprinting URLs
	 *
	 * Call once immediately after context creation, before any pages are opened.
	 */
	async applyToContext(context: BrowserContext): Promise<void> {
		await context.addInitScript(this.script);
		await context.setExtraHTTPHeaders(this.clientHintHeaders);

		// Block fingerprinting and tracking URLs at the route level.
		// This runs BEFORE Ghostery and catches domain-specific trackers.
		for (const pattern of this.blockedUrls) {
			await context.route(pattern, (route) => route.abort());
		}
	}

	/**
	 * Apply the anti-detection init script directly to a page.
	 *
	 * Necessary for pages that already existed when the context was created
	 * (context-level addInitScript only applies to pages created AFTER the call).
	 */
	async applyToPage(page: Page): Promise<void> {
		await page.addInitScript(this.script);
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
