/**
 * Minimal warm-mint page — strips NVIDIA's React UI from the mint critical
 * path. Same E6 binding (SDK trap → __bn_mintToken), same origin/persona,
 * but the document is a 200-byte stub instead of a multi-MB SPA.
 *
 * Why this works:
 *   hCaptcha's invisible widget only requires three things from the parent
 *   page: the right Origin (sitekey 0c6a1e45… is registered for
 *   `build.nvidia.com`), the loader script (`api.js`), and a
 *   `<div class="h-captcha" data-sitekey=… data-size="invisible">` for the
 *   SDK to render against. NVIDIA's React app is irrelevant to mint.
 *
 *   We register a page-level route that fulfills `https://build.nvidia.com/__warm`
 *   with a static HTML stub. Any other URL on the page (api.js, hcaptcha
 *   iframe assets, etc.) flows through normally so the SDK loads from its
 *   real CDN. The persona + SDK-trap init scripts already attach at context
 *   level so they're inherited by this page's main world too.
 *
 * Cost vs. driving the model UI:
 *   - First mint: skip ~3-5MB JS download + React boot. Page load drops
 *     from ~3-5s to ~200-400ms.
 *   - Subsequent mints: identical to E6 (~330ms — bound by WASM proof).
 *   - Per-page memory: tiny, since no React/Next runtime is loaded.
 */

import type { CdpScriptControl, RemoteBrowserService } from '@interceptor/browser/remote';
import type { Page } from 'patchright';

import { NVIDIA_SITEKEY } from './captcha-frame';
import { type BuildNvidiaPersona, buildBuildNvidiaFingerprintScript } from './fingerprint-script';
import { buildSdkTrapScript, SDK_TRAP_GLOBALS } from './sdk-trap';

/** A real hostname is required (sitekey is bound to build.nvidia.com).
 *  The path is arbitrary — `__warm` is unlikely to collide with anything
 *  NVIDIA actually serves and makes the intent obvious in network logs. */
const WARM_URL = 'https://build.nvidia.com/__warm';

const WARM_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>warm</title>
<script src="https://js.hcaptcha.com/1/api.js" async defer></script>
</head>
<body>
<div class="h-captcha" data-sitekey="${NVIDIA_SITEKEY}" data-size="invisible"></div>
</body>
</html>`;

interface WarmPageState {
	page: Page;
}

/**
 * Per-browser warm-mint page registry. We share one page per browser
 * session — concurrency is gated by the existing per-browser mint mutex
 * (hCaptcha's SDK has an internal `_pendingExecute` that hates parallel
 * calls anyway).
 */
const warmPages = new WeakMap<object, WarmPageState>();
const routeRegistered = new WeakSet<object>();
const initScriptsAttached = new WeakSet<object>();

async function ensureWarmInitScripts(
	browser: RemoteBrowserService,
	control: CdpScriptControl,
	persona: BuildNvidiaPersona | undefined,
): Promise<void> {
	const key = browser as unknown as object;
	if (initScriptsAttached.has(key)) return;
	// IIFE-guarded scripts are idempotent inside a realm, so registering
	// them again on a context that already has them adds a duplicate
	// init-script entry that no-ops at run time. We still skip on
	// re-entry to avoid bloating the script list.
	await control.registerInitScript(buildBuildNvidiaFingerprintScript(persona ?? {}));
	await control.registerInitScript(buildSdkTrapScript());
	initScriptsAttached.add(key);
}

export interface WarmMintOptions {
	/**
	 * Persona overrides for this browser. Applied via init script before any
	 * page navigation. If a persona was already attached to this browser
	 * (e.g., by a BrowserPool's PersonaAttacher), the second call is a no-op
	 * — the first persona wins. Pool callers should pre-attach.
	 */
	persona?: BuildNvidiaPersona;
}

/**
 * Get (or lazily create) the warm-mint page for this browser session. The
 * returned page is on `build.nvidia.com` origin, has hCaptcha loaded, the
 * SDK trap captured, and an invisible widget rendered — ready for
 * `__bn_mintToken()`.
 */
export async function getWarmMintPage(
	browser: RemoteBrowserService,
	opts: WarmMintOptions = {},
): Promise<Page> {
	const key = browser as unknown as object;
	const existing = warmPages.get(key);
	if (existing && !existing.page.isClosed()) return existing.page;

	const control = browser.getScriptControl();
	if (!control) throw new Error('No CdpScriptControl on browser session');
	// Init scripts MUST be registered before getOrCreatePage so the new
	// page's session inherits them at adoption time.
	await ensureWarmInitScripts(browser, control, opts.persona);

	const page = await browser.getOrCreatePage('build-nvidia-warm');

	if (!routeRegistered.has(key)) {
		await page.route(WARM_URL, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: WARM_HTML,
			});
		});
		routeRegistered.add(key);
	}

	if (!page.url().startsWith(WARM_URL)) {
		await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
	}

	// Wait for SDK trap to capture + widget to render. The `data-hcaptcha-widget-id`
	// attribute appears once the SDK has finished autoRendering the
	// `.h-captcha` div, which means the iframe is loaded and execute() is
	// callable.
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const r = (await control.evaluateInMainWorld<{
			captured: boolean;
			hasExecute?: boolean;
			hasWidget?: boolean;
		}>(
			`(() => { const i = window.__bn_sdkInfo ? window.__bn_sdkInfo() : { captured: false }; return Object.assign({}, i, { hasWidget: !!document.querySelector('[data-hcaptcha-widget-id]') }); })()`,
			{ page },
		)) as { captured: boolean; hasExecute?: boolean; hasWidget?: boolean } | null;
		if (r && r.captured && r.hasExecute && r.hasWidget) {
			warmPages.set(key, { page });
			return page;
		}
		await new Promise((res) => setTimeout(res, 100));
	}
	throw new Error('Warm-mint page never captured SDK + rendered widget');
}

export interface WarmMintCallOptions extends WarmMintOptions {
	sitekey?: string;
	timeoutMs?: number;
}

/**
 * Mint a fresh hCaptcha token via the warm-mint page. The page is created
 * lazily on first call; subsequent calls reuse it.
 *
 * NOTE: this does NOT acquire the per-browser mint mutex — callers that
 * may issue concurrent mints (the chat-completions handler) should wrap
 * this in `withMintLock` exactly as `mintViaBinding` is wrapped.
 */
export async function mintViaWarmPage(
	browser: RemoteBrowserService,
	opts: WarmMintCallOptions = {},
): Promise<string> {
	const sitekey = opts.sitekey ?? NVIDIA_SITEKEY;
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const page = await getWarmMintPage(browser, { persona: opts.persona });
	const control = browser.getScriptControl();
	if (!control) throw new Error('No CdpScriptControl');
	const expr = `(async () => {
		try {
			const t = await window.${SDK_TRAP_GLOBALS.mint}(${JSON.stringify(sitekey)});
			return { ok: true, token: t };
		} catch (e) {
			return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
		}
	})()`;
	const result = (await control.evaluateInMainWorld<{
		ok: boolean;
		token?: string;
		error?: string;
	}>(expr, { awaitPromise: true, timeoutMs, page })) as {
		ok: boolean;
		token?: string;
		error?: string;
	} | null;
	if (!result) throw new Error('mintViaWarmPage: evaluateInMainWorld returned null');
	if (!result.ok) throw new Error(`mintViaWarmPage: ${result.error ?? 'unknown error'}`);
	if (typeof result.token !== 'string' || result.token.length === 0) {
		throw new Error('mintViaWarmPage: token missing or empty');
	}
	return result.token;
}

/** Diagnostic — peek at the warm page's main-world state. */
export async function inspectWarmPage(
	browser: RemoteBrowserService,
): Promise<Record<string, unknown> | null> {
	const key = browser as unknown as object;
	const existing = warmPages.get(key);
	if (!existing || existing.page.isClosed()) return { warm: false };
	const control = browser.getScriptControl();
	if (!control) return null;
	return control.evaluateInMainWorld<Record<string, unknown>>(
		`(() => {
			const sdkInfo = window.__bn_sdkInfo ? window.__bn_sdkInfo() : null;
			return {
				warm: true,
				url: location.href,
				origin: location.origin,
				userAgent: navigator.userAgent,
				hasHcaptcha: typeof window.hcaptcha,
				hasMint: typeof window.${SDK_TRAP_GLOBALS.mint},
				widgetEl: !!document.querySelector('[data-hcaptcha-widget-id]'),
				hcaptchaDiv: !!document.querySelector('.h-captcha'),
				scriptsLoaded: Array.from(document.querySelectorAll('script')).map(s => s.src || '<inline>'),
				sdkInfo,
			};
		})()`,
		{ page: existing.page },
	);
}
