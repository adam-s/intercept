/**
 * FingerprintController — intercepts and optionally rewrites Cloudflare Turnstile
 * and ChatGPT Sentinel scripts before they are evaluated.
 *
 * Mechanism:
 *   page.route() intercepts ALL frames (including cross-origin iframes like
 *   challenges.cloudflare.com). When a matching script is fetched, we rewrite the
 *   JS text to prepend a logging proxy, then route.fulfill() with the modified body.
 *   The rewritten script runs instead of the original inside the iframe.
 *
 * Two operating modes:
 *   - 'log'     — intercept and observe: wrap property reads to emit what Turnstile collects
 *   - 'control' — log mode + replace the collected values with the active fingerprint profile
 */

import { EventEmitter } from 'node:events';
import type { FingerprintProfile } from '@interceptor/shared';
import type { Page, Route } from 'patchright';

export type ScriptInterceptorMode = 'log' | 'control';

export interface FingerprintLogEntry {
	timestamp: number;
	/** Which layer: 'browser' | 'behavioral' | 'app_state' */
	layer: string;
	/** Property name e.g. 'UNMASKED_RENDERER_WEBGL', '__reactRouterContext' */
	property: string;
	/** Value that was read (or would have been sent) */
	value: unknown;
	/** Source frame URL */
	frameUrl?: string;
}

/** Patterns for Cloudflare Turnstile / ChatGPT Sentinel script requests */
const TURNSTILE_PATTERNS = [
	'**/challenges.cloudflare.com/**',
	'**/*turnstile*',
	'**/cdn-cgi/challenge-platform/**',
	'**/chatgpt.com/_next/static/chunks/**sentinel**',
	'**/chatgpt.com/_next/static/chunks/**oai-so**',
];

/**
 * JS code prepended to every intercepted script.
 * Wraps property access on navigator, screen, WebGL etc. to log reads.
 * In 'control' mode the profile values are injected and returned instead.
 */
function buildLoggingPreamble(
	mode: ScriptInterceptorMode,
	profile: FingerprintProfile | undefined,
): string {
	const profileJson = profile ? JSON.stringify(profile) : 'null';
	return `
(function __fp_logger() {
	const __fp_mode = ${JSON.stringify(mode)};
	const __fp_profile = ${profileJson};
	const __fp_log = (layer, property, value) => {
		try {
			window.__fp_log_entries = window.__fp_log_entries || [];
			window.__fp_log_entries.push({ t: Date.now(), layer, property, value: String(value).slice(0, 200) });
			// Cap at 500 entries
			if (window.__fp_log_entries.length > 500) window.__fp_log_entries.shift();
		} catch(e) {}
	};

	if (__fp_mode === 'control' && __fp_profile) {
		// Override getParameter to return profile values and log them
		const _origGC = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function(type) {
			const ctx = _origGC.apply(this, arguments);
			if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
				const _origGP = ctx.getParameter.bind(ctx);
				ctx.getParameter = function(param) {
					const wgl = __fp_profile.browser && __fp_profile.browser.webgl;
					if (param === 37445 && wgl) { __fp_log('browser', 'UNMASKED_VENDOR_WEBGL', wgl.vendor); return wgl.vendor; }
					if (param === 37446 && wgl) { __fp_log('browser', 'UNMASKED_RENDERER_WEBGL', wgl.renderer); return wgl.renderer; }
					const v = _origGP(param);
					__fp_log('browser', 'webgl_param_' + param, v);
					return v;
				};
			}
			return ctx;
		};
	}
})();
`;
}

export class ScriptInterceptor extends EventEmitter {
	private mode: ScriptInterceptorMode;
	private profile: FingerprintProfile | undefined;
	private attached = false;
	private page: Page | null = null;
	private routeHandlers: Array<{ pattern: string; handler: (route: Route) => Promise<void> }> = [];

	constructor(mode: ScriptInterceptorMode = 'log', profile?: FingerprintProfile) {
		super();
		this.mode = mode;
		this.profile = profile;
	}

	/** Attach to a Patchright page — installs route interceptors for all Turnstile patterns. */
	async attach(page: Page): Promise<void> {
		if (this.attached) return;
		this.page = page;
		this.attached = true;

		for (const pattern of TURNSTILE_PATTERNS) {
			const handler = async (route: Route) => {
				await this.handleScriptRoute(route);
			};
			await page.route(pattern, handler);
			this.routeHandlers.push({ pattern, handler });
		}

		// Install the log-entry collector: poll window.__fp_log_entries and emit events
		this.startLogPoll(page);
		console.log('[FingerprintController] Attached to page');
	}

	async detach(): Promise<void> {
		if (!this.page || !this.attached) return;
		for (const { pattern } of this.routeHandlers) {
			await this.page.unroute(pattern).catch(() => {});
		}
		this.routeHandlers = [];
		this.attached = false;
		this.page = null;
	}

	setMode(mode: ScriptInterceptorMode): void {
		this.mode = mode;
	}

	setProfile(profile: FingerprintProfile | undefined): void {
		this.profile = profile;
	}

	private async handleScriptRoute(route: Route): Promise<void> {
		const req = route.request();
		const url = req.url();

		// Only intercept JS
		try {
			const response = await route.fetch();
			const ct = response.headers()['content-type'] ?? '';

			if (!ct.includes('javascript') && !ct.includes('ecmascript')) {
				await route.fulfill({ response });
				return;
			}

			const originalBody = await response.text();
			const preamble = buildLoggingPreamble(this.mode, this.profile);
			const rewrittenBody = preamble + '\n' + originalBody;

			this.emit('script-intercepted', { url, size: originalBody.length });

			await route.fulfill({
				status: response.status(),
				headers: response.headers(),
				body: rewrittenBody,
			});
		} catch (err) {
			// If fetch fails (e.g., network error), continue without modification
			console.warn(`[FingerprintController] Route fetch failed for ${url}:`, err);
			await route.continue().catch(() => {});
		}
	}

	/** Poll window.__fp_log_entries every 500ms and emit 'entry' events. */
	private startLogPoll(page: Page): void {
		let lastCount = 0;
		const poll = async () => {
			if (!this.attached || page.isClosed()) return;
			try {
				const entries = await page.evaluate(() => {
					const all = (window as unknown as Record<string, unknown>).__fp_log_entries as
						| Array<{ t: number; layer: string; property: string; value: unknown }>
						| undefined;
					return all ?? null;
				});
				if (entries && entries.length > lastCount) {
					const newEntries = entries.slice(lastCount);
					lastCount = entries.length;
					for (const e of newEntries) {
						this.emit('entry', {
							timestamp: e.t,
							layer: e.layer,
							property: e.property,
							value: e.value,
						} satisfies FingerprintLogEntry);
					}
				}
			} catch {
				// Page may have navigated — ignore
			}
			if (this.attached) {
				setTimeout(poll, 500);
			}
		};
		setTimeout(poll, 500);
	}
}
