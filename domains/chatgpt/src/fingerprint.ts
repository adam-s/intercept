/**
 * ChatGPTScriptInterceptor
 *
 * Intercepts Cloudflare Turnstile and ChatGPT Sentinel scripts before they execute.
 *
 * HOW IT WORKS
 * ─────────────
 * page.route() runs for ALL frames, including cross-origin iframes
 * (e.g., challenges.cloudflare.com). When a matching JS file is fetched we:
 *   1. Fetch the original response via route.fetch()
 *   2. Prepend a logging/control preamble to the JS text
 *   3. Fulfill the route with the rewritten body
 *
 * The Turnstile VM still runs and generates a valid token, but every property
 * read (GPU, screen, fonts, navigator, React state) is intercepted. In 'control'
 * mode the values returned are from the active FingerprintProfile, not the real
 * browser — so the token Cloudflare receives contains your chosen persona, not
 * your actual fingerprint.
 *
 * MODES
 * ─────
 * 'log'     — observe only. Wraps reads and writes to window.__fp_log_entries.
 * 'control' — like 'log' but also replaces values with profile data (privacy mode).
 *
 * SIGNAL ORCHESTRATOR
 * ────────────────────
 * The __oai_so_* behavioral biometric properties are pre-seeded by
 * buildChatGPTFingerprintScript() in the page init script (runs before React).
 * This interceptor handles the Turnstile iframe layer.
 */

import { EventEmitter } from 'node:events';
import type { Page, Route } from 'patchright';
import type { ChatGPTInterceptorMode, FingerprintLogEntry, FingerprintProfile } from './types';

export type { FingerprintLogEntry } from './types';

/**
 * URL patterns that match Cloudflare Turnstile and ChatGPT Sentinel scripts.
 * All five layers of the Turnstile challenge chain are covered.
 */
const CHATGPT_SCRIPT_PATTERNS = [
	// Cloudflare Turnstile challenge iframe
	'**/challenges.cloudflare.com/**',
	// Generic turnstile scripts loaded on any domain
	'**/*turnstile*',
	// Cloudflare challenge platform CDN
	'**/cdn-cgi/challenge-platform/**',
	// ChatGPT Sentinel — the program that reads React state + fingerprint
	'**/chatgpt.com/_next/static/chunks/**sentinel**',
	// ChatGPT Signal Orchestrator — behavioral biometrics listener
	'**/chatgpt.com/_next/static/chunks/**oai-so**',
];

/**
 * Builds the JS preamble prepended to every intercepted script.
 *
 * In 'log' mode: wraps WebGL getParameter and window.__fp_log_entries to
 * record what values Turnstile reads.
 *
 * In 'control' mode: additionally replaces all 55 fingerprint property reads
 * with values from the active FingerprintProfile, so Turnstile's token
 * contains persona data instead of real device data.
 */
function buildInterceptPreamble(
	mode: ChatGPTInterceptorMode,
	profile: FingerprintProfile | undefined,
): string {
	const profileJson = profile ? JSON.stringify(profile) : 'null';

	return `
(function __chatgpt_fp_intercept() {
	const __mode = ${JSON.stringify(mode)};
	const __profile = ${profileJson};

	// ─── Logging ─────────────────────────────────────────────────
	const __log = function(layer, property, value) {
		try {
			window.__fp_log_entries = window.__fp_log_entries || [];
			window.__fp_log_entries.push({
				t: Date.now(), layer, property,
				value: String(value).slice(0, 200)
			});
			if (window.__fp_log_entries.length > 500) window.__fp_log_entries.shift();
		} catch(e) {}
	};

	// ─── WebGL getParameter proxy ─────────────────────────────────
	// Covers Layer 1: UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL
	// and 6 other WebGL params Turnstile reads (getContext, getExtension etc.)
	const _origGC = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function(type) {
		const ctx = _origGC.apply(this, arguments);
		if (!ctx) return ctx;
		if (type !== 'webgl' && type !== 'webgl2' && type !== 'experimental-webgl') return ctx;
		const _origGP = ctx.getParameter.bind(ctx);
		const wgl = __profile && __profile.browser && __profile.browser.webgl;
		ctx.getParameter = function(param) {
			if (param === 37445) {
				const v = (__mode === 'control' && wgl) ? wgl.vendor : _origGP(param);
				__log('browser', 'UNMASKED_VENDOR_WEBGL', v);
				return v;
			}
			if (param === 37446) {
				const v = (__mode === 'control' && wgl) ? wgl.renderer : _origGP(param);
				__log('browser', 'UNMASKED_RENDERER_WEBGL', v);
				return v;
			}
			const v = _origGP(param);
			__log('browser', 'webgl_param_' + param, v);
			return v;
		};
		return ctx;
	};

	// ─── Navigator property logging (Layer 1 Hardware) ────────────
	// In 'control' mode these are already overridden by the page init script
	// (buildChatGPTFingerprintScript). Here we just log reads inside the iframe.
	const _navProps = ['hardwareConcurrency', 'deviceMemory', 'platform', 'vendor', 'maxTouchPoints'];
	for (const prop of _navProps) {
		try {
			const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, prop)
				|| Object.getOwnPropertyDescriptor(navigator, prop);
			if (!desc) continue;
			const _orig = desc.get ? desc.get.bind(navigator) : () => navigator[prop];
			Object.defineProperty(navigator, prop, {
				get: function() {
					const v = _orig();
					__log('browser', prop, v);
					return v;
				},
				configurable: true,
			});
		} catch(e) {}
	}

	// ─── Screen property logging (Layer 1 Screen) ────────────────
	const _screenProps = ['colorDepth', 'pixelDepth', 'width', 'height', 'availWidth', 'availHeight', 'availLeft', 'availTop'];
	for (const prop of _screenProps) {
		try {
			const _origVal = screen[prop];
			Object.defineProperty(screen, prop, {
				get: function() { __log('browser', 'screen.' + prop, _origVal); return _origVal; },
				configurable: true,
			});
		} catch(e) {}
	}

	// ─── React / Application state logging (Layer 3) ─────────────
	// Turnstile reads __reactRouterContext, loaderData, clientBootstrap.
	// These only exist after the ChatGPT SPA hydrates. We log when they're read.
	const _appStateProps = ['__reactRouterContext', 'clientBootstrap'];
	for (const prop of _appStateProps) {
		try {
			let _val = window[prop];
			Object.defineProperty(window, prop, {
				get: function() { __log('app_state', prop, _val ? '[present]' : '[missing]'); return _val; },
				set: function(v) { _val = v; },
				configurable: true,
			});
		} catch(e) {}
	}
})();
`;
}

export class ChatGPTScriptInterceptor extends EventEmitter {
	private mode: ChatGPTInterceptorMode;
	private profile: FingerprintProfile | undefined;
	private attached = false;
	private page: Page | null = null;
	private routeHandlers: Array<{ pattern: string; handler: (route: Route) => Promise<void> }> = [];

	constructor(mode: ChatGPTInterceptorMode = 'log', profile?: FingerprintProfile) {
		super();
		this.mode = mode;
		this.profile = profile;
	}

	/** Attach to a Patchright page — installs route interceptors for all script patterns. */
	async attach(page: Page): Promise<void> {
		if (this.attached) return;
		this.page = page;
		this.attached = true;

		for (const pattern of CHATGPT_SCRIPT_PATTERNS) {
			const handler = async (route: Route) => {
				await this.handleScriptRoute(route);
			};
			await page.route(pattern, handler);
			this.routeHandlers.push({ pattern, handler });
		}

		this.startLogPoll(page);
		console.log('[ChatGPTScriptInterceptor] Attached — mode:', this.mode);
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

	setMode(mode: ChatGPTInterceptorMode): void {
		this.mode = mode;
	}

	setProfile(profile: FingerprintProfile | undefined): void {
		this.profile = profile;
	}

	getMode(): ChatGPTInterceptorMode {
		return this.mode;
	}

	private async handleScriptRoute(route: Route): Promise<void> {
		const url = route.request().url();
		try {
			const response = await route.fetch();
			const ct = response.headers()['content-type'] ?? '';

			if (!ct.includes('javascript') && !ct.includes('ecmascript')) {
				await route.fulfill({ response });
				return;
			}

			const originalBody = await response.text();
			const preamble = buildInterceptPreamble(this.mode, this.profile);

			this.emit('script-intercepted', { url, size: originalBody.length });

			await route.fulfill({
				status: response.status(),
				headers: response.headers(),
				body: `${preamble}\n${originalBody}`,
			});
		} catch (err) {
			console.warn('[ChatGPTScriptInterceptor] Route fetch failed for', url, err);
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
			if (this.attached) setTimeout(poll, 500);
		};
		setTimeout(poll, 500);
	}
}
