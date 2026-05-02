/**
 * ChatGPTScriptInterceptor
 *
 * Persona-aware fingerprint stealth for chatgpt.com — runs entirely through
 * the raw-CDP `CdpScriptControl` surface owned by RemoteBrowserService.
 *
 * WHAT IT DOES
 * ─────────────
 * 1. Registers an init script (`buildChatGPTFingerprintScript`) via
 *    Page.addScriptToEvaluateOnNewDocument. The script:
 *      - Replaces all 55 properties Cloudflare Turnstile / ChatGPT Sentinel
 *        read (WebGL, navigator, screen, fonts, plugins, AudioContext, …).
 *      - Pre-seeds the 36 `window.__oai_so_*` behavioural-biometric values.
 *      - Hardens the overrides so descriptor introspection and
 *        `Function.prototype.toString` checks return native-looking output.
 *    The script runs in the main world before ANY page or subframe script,
 *    including in cross-origin iframes (auto-propagated by Chromium).
 *
 * 2. (Log mode only.) Registers a Fetch.requestPaused capture for Cloudflare
 *    Turnstile, challenge-platform, Sentinel, and __oai_so script bundles.
 *    Bodies are read but NEVER modified — modifying the bytes risks tripping
 *    self-checksums in the Turnstile VM. Instead the bodies are emitted as
 *    `script-captured` events for offline analysis.
 *
 * WHY THIS DESIGN
 * ────────────────
 * The previous implementation used `page.route()` and prepended a JS
 * preamble to each Cloudflare/Sentinel script. That approach (a) leaks
 * Patchright route timing/header artifacts to in-page scripts, and (b)
 * is fragile — Turnstile bundles are XOR-encrypted and may self-checksum.
 * The new design controls the *environment* before scripts run, not the
 * bytes of the scripts themselves.
 *
 * MODES
 * ─────
 * 'log'     — install hooks; capture script bodies as 'script-captured' events.
 * 'control' — install hooks (full persona override); no body capture.
 *
 * HOW TO USE
 * ──────────
 *   const interceptor = new ChatGPTScriptInterceptor('control', profile);
 *   await interceptor.attach(browser.getScriptControl()!);
 *   interceptor.on('entry', (e) => ...);          // property reads from in-page script
 *   interceptor.on('script-captured', (s) => ...); // log-mode body dumps
 */

import { EventEmitter } from 'node:events';
import type {
	CapturedScript,
	CdpScriptControl,
	InitScriptHandle,
} from '@interceptor/browser/remote';
import type { Page } from 'patchright';
import { buildChatGPTFingerprintScript } from './fingerprint-script';
import type { ChatGPTInterceptorMode, FingerprintLogEntry, FingerprintProfile } from './types';

export type { FingerprintLogEntry } from './types';

/**
 * URL globs (CDP `Fetch.enable` urlPattern syntax — `*` matches any chars)
 * that capture every script in the Cloudflare Turnstile / ChatGPT Sentinel
 * load chain. Used in `log` mode for body capture only.
 */
const CHATGPT_SCRIPT_PATTERNS: readonly string[] = [
	'*challenges.cloudflare.com*',
	'*turnstile*',
	'*cdn-cgi/challenge-platform*',
	'*chatgpt.com/_next/static/chunks/*sentinel*',
	'*chatgpt.com/_next/static/chunks/*oai-so*',
];

/**
 * Tiny side-channel script: reads the persona script's log buffer
 * (`window.__fp_log_entries`) on a 500 ms interval and surfaces entries to
 * Node via a CDP-bound page binding. The persona script writes to that
 * buffer whenever a Turnstile-iframe property read goes through one of our
 * intercepted getters.
 *
 * Kept here (not in the persona script) so log-mode plumbing is testable
 * independently of the much larger persona payload.
 */
const LOG_DRAIN_SCRIPT = `
(function __chatgpt_fp_log_drain() {
	if (window.__fp_log_drain_installed) return;
	window.__fp_log_drain_installed = true;
	let lastSent = 0;
	setInterval(() => {
		try {
			const all = window.__fp_log_entries;
			if (!all || all.length <= lastSent) return;
			const next = all.slice(lastSent);
			lastSent = all.length;
			if (typeof window.__fp_emit_entries === 'function') {
				try { window.__fp_emit_entries(JSON.stringify(next)); } catch (e) {}
			}
		} catch (e) {}
	}, 500);
})();
`;

export class ChatGPTScriptInterceptor extends EventEmitter {
	private mode: ChatGPTInterceptorMode;
	private profile: FingerprintProfile | undefined;
	private control: CdpScriptControl | null = null;
	private personaHandle: InitScriptHandle | null = null;
	private drainHandle: InitScriptHandle | null = null;
	private stopCapture: (() => Promise<void>) | null = null;
	private bindingsInstalled = new WeakSet<Page>();

	constructor(mode: ChatGPTInterceptorMode = 'control', profile?: FingerprintProfile) {
		super();
		this.mode = mode;
		this.profile = profile;
	}

	getMode(): ChatGPTInterceptorMode {
		return this.mode;
	}

	/**
	 * Attach to the raw-CDP control surface. Idempotent: a second `attach`
	 * call rebuilds the persona script with the latest mode/profile.
	 */
	async attach(control: CdpScriptControl): Promise<void> {
		this.control = control;

		// Tear down any previous registration so mode/profile changes take effect.
		await this.unregisterScripts();

		// 1. Install the persona script. Runs in main world, before any page
		//    or subframe script (Chromium auto-propagates to OOPIFs).
		const personaSource = buildChatGPTFingerprintScript(this.profile);
		this.personaHandle = await control.registerInitScript(personaSource);

		// 2. Install the log-drain script so Turnstile-iframe property reads
		//    surface to Node. Same install path; runs after the persona script
		//    in registration order.
		this.drainHandle = await control.registerInitScript(LOG_DRAIN_SCRIPT);

		// 3. In log mode: capture upstream script bodies for offline analysis.
		if (this.mode === 'log') {
			this.stopCapture = await control.captureScripts(
				{ urlPattern: '*', resourceType: 'Script' },
				(s) => this.onScriptCaptured(s),
			);
		}

		console.log(
			`[ChatGPTScriptInterceptor] Attached via CDP — mode: ${this.mode}, profile: ${this.profile?.name ?? '(none)'}`,
		);
	}

	async detach(): Promise<void> {
		await this.unregisterScripts();
		this.control = null;
	}

	setMode(mode: ChatGPTInterceptorMode): void {
		this.mode = mode;
	}

	setProfile(profile: FingerprintProfile | undefined): void {
		this.profile = profile;
	}

	/**
	 * Install a CDP page binding that the in-page log-drain script calls with
	 * batched property-read entries. Must be called per page after the page
	 * exists (the persona script's `window.__fp_emit_entries` is a no-op
	 * until we install the binding here). Service code can call this on the
	 * primary page after `attach`.
	 */
	async bindLogChannel(page: Page): Promise<void> {
		if (this.bindingsInstalled.has(page)) return;
		this.bindingsInstalled.add(page);

		await page
			.exposeFunction('__fp_emit_entries', (json: string) => {
				try {
					const arr = JSON.parse(json) as Array<{
						t: number;
						layer: string;
						property: string;
						value: unknown;
					}>;
					for (const e of arr) {
						this.emit('entry', {
							timestamp: e.t,
							layer: e.layer,
							property: e.property,
							value: e.value,
						} satisfies FingerprintLogEntry);
					}
				} catch {
					/* ignore malformed batch */
				}
			})
			.catch(() => {
				/* binding may already exist on persistent contexts */
			});
	}

	// ─── Internals ────────────────────────────────────────────────────

	private async unregisterScripts(): Promise<void> {
		if (this.stopCapture) {
			await this.stopCapture().catch(() => {});
			this.stopCapture = null;
		}
		if (this.control && this.personaHandle) {
			await this.control.unregisterInitScript(this.personaHandle).catch(() => {});
			this.personaHandle = null;
		}
		if (this.control && this.drainHandle) {
			await this.control.unregisterInitScript(this.drainHandle).catch(() => {});
			this.drainHandle = null;
		}
	}

	private onScriptCaptured(captured: CapturedScript): void {
		// Filter on URL — captureScripts uses `*` so we receive all scripts
		// and route filtering here. Cheaper than registering 5 separate
		// per-pattern handlers since they all flow to the same listener.
		if (!CHATGPT_SCRIPT_PATTERNS.some((p) => globMatch(captured.url, p))) return;
		this.emit('script-captured', {
			url: captured.url,
			resourceType: captured.resourceType,
			status: captured.responseStatusCode,
			size: captured.body.length,
			body: captured.body,
			base64Encoded: captured.base64Encoded,
		});
	}
}

function globMatch(url: string, pattern: string): boolean {
	if (pattern === '*' || pattern === '') return true;
	const regex = new RegExp(
		`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
	);
	return regex.test(url);
}
