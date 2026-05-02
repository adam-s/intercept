/**
 * buildChatGPTFingerprintScript
 *
 * Generates the full page init script (addInitScript / CDP
 * Page.addScriptToEvaluateOnNewDocument) for chatgpt.com.
 *
 * Covers all 55 properties Cloudflare Turnstile / ChatGPT Sentinel reads
 * (Buchodi's bytecode analysis) plus ChatGPT-specific Signal Orchestrator
 * pre-seeding of the 36 window.__oai_so_* behavioral biometric properties.
 *
 * Everything lives here because FingerprintProfile and the script builder
 * are ChatGPT-specific — they belong in the domain, not in @interceptor/browser.
 */

import type { FingerprintProfile } from './types';

// ---------------------------------------------------------------------------
// Generic anti-detection init script (Turnstile Layer 1 — 55 properties)
// ---------------------------------------------------------------------------

function buildFingerprintScript(profile?: FingerprintProfile): string {
	const hw = profile?.browser?.hardware;
	const screen = profile?.browser?.screen;
	const webgl = profile?.browser?.webgl;
	const plugins = profile?.browser?.plugins;
	const fonts = profile?.browser?.fonts;
	const appState = profile?.applicationState;

	const screenOffsetX = profile?.screenOffsetX ?? 800 + Math.floor(Math.random() * 400);
	const screenOffsetY = profile?.screenOffsetY ?? 300 + Math.floor(Math.random() * 300);

	// --- plugins JS ---
	const pluginList = plugins ?? [
		{
			name: 'PDF Viewer',
			filename: 'internal-pdf-viewer',
			description: 'Portable Document Format',
		},
		{
			name: 'Chrome PDF Viewer',
			filename: 'internal-pdf-viewer',
			description: 'Portable Document Format',
		},
		{
			name: 'Chromium PDF Viewer',
			filename: 'internal-pdf-viewer',
			description: 'Portable Document Format',
		},
		{
			name: 'Microsoft Edge PDF Viewer',
			filename: 'internal-pdf-viewer',
			description: 'Portable Document Format',
		},
		{
			name: 'WebKit built-in PDF',
			filename: 'internal-pdf-viewer',
			description: 'Portable Document Format',
		},
	];
	const pluginEntries = pluginList
		.map(
			(p, i) =>
				`${i}: { name: ${JSON.stringify(p.name)}, filename: ${JSON.stringify(p.filename)}, description: ${JSON.stringify(p.description)} }`,
		)
		.join(', ');

	// --- font measurement JS ---
	const fontMapJs = fonts
		? `const __fp_fonts = ${JSON.stringify(fonts)};`
		: 'const __fp_fonts = null;';

	// --- screen JS helpers ---
	const screenJs = screen
		? `
		Object.defineProperty(screen, 'colorDepth', { get: () => ${screen.colorDepth ?? 24} });
		Object.defineProperty(screen, 'pixelDepth', { get: () => ${screen.pixelDepth ?? 24} });
		Object.defineProperty(screen, 'width', { get: () => ${screen.width ?? 1512} });
		Object.defineProperty(screen, 'height', { get: () => ${screen.height ?? 982} });
		Object.defineProperty(screen, 'availWidth', { get: () => ${screen.availWidth ?? 1512} });
		Object.defineProperty(screen, 'availHeight', { get: () => ${screen.availHeight ?? 946} });
		Object.defineProperty(screen, 'availLeft', { get: () => ${screen.availLeft ?? 0} });
		Object.defineProperty(screen, 'availTop', { get: () => ${screen.availTop ?? 36} });
		`
		: `
		Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
		Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
		`;

	// --- app state JS ---
	const appStateJs =
		appState?.reactRouterContextPresent === false
			? ''
			: `
		// Ensure React Router context appears present (checked by Turnstile Layer 3)
		Object.defineProperty(window, '__fp_sentinel_app_state_ready', { value: true, writable: false });
		`;

	return `(function() {
	// Installation marker visible to ANY world (DOM is shared across worlds;
	// window/navigator overrides are not). Use it from /browser/mcp/evaluate
	// to confirm the persona script reached the page.
	try { if (document && document.documentElement) document.documentElement.setAttribute('data-fp-persona-ran', '1'); } catch(e) {}

	// ─── Hardening Prelude ────────────────────────────────────────────
	// 1. Patch Function.prototype.toString so every getter we install
	//    later in this IIFE returns "function get NAME() { [native code] }"
	//    when introspected — defeating Sentinel's getter.toString() checks.
	// 2. Initialise the log buffer used by the page-level log-drain.
	// 3. Provide __fp_setNative(fn, name) used by the post-pass at the
	//    bottom of this IIFE to mark every getter we installed.
	const __fp_origFnToString = Function.prototype.toString;
	const __fp_fakeNatives = new WeakMap();
	const __fp_setNative = function(fn, displayName) {
		try { __fp_fakeNatives.set(fn, displayName); } catch(e) {}
		return fn;
	};
	const __fp_toStringProxy = new Proxy(__fp_origFnToString, {
		apply: function(target, thisArg, args) {
			try {
				if (thisArg && __fp_fakeNatives.has(thisArg)) {
					return 'function ' + __fp_fakeNatives.get(thisArg) + '() { [native code] }';
				}
			} catch(e) {}
			return Reflect.apply(target, thisArg, args);
		}
	});
	Function.prototype.toString = __fp_toStringProxy;
	__fp_setNative(__fp_toStringProxy, 'toString');

	// Public log buffer — read every 500ms by the page-level log-drain
	// script (registered separately by ChatGPTScriptInterceptor).
	try { window.__fp_log_entries = window.__fp_log_entries || []; } catch(e) {}
	const __fp_log = function(layer, prop, value) {
		try {
			const arr = window.__fp_log_entries; if (!arr) return;
			arr.push({ t: Date.now(), layer: layer, property: prop, value: String(value).slice(0, 200) });
			if (arr.length > 1000) arr.shift();
		} catch(e) {}
	};

	// === Core Navigator Overrides ===
	Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(hw?.platform ?? 'MacIntel')} });
	Object.defineProperty(navigator, 'vendor', { get: () => ${JSON.stringify(hw?.vendor ?? 'Google Inc.')} });
	Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
	Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(profile?.languages ?? ['en-US', 'en'])} });
	Object.defineProperty(navigator, 'language', { get: () => ${JSON.stringify(profile?.language ?? 'en-US')} });
	Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${hw?.hardwareConcurrency ?? 8} });
	Object.defineProperty(navigator, 'deviceMemory', { get: () => ${hw?.deviceMemory ?? 8} });
	Object.defineProperty(navigator, 'maxTouchPoints', { get: () => ${hw?.maxTouchPoints ?? 0} });

	// === Plugins ===
	const fakePlugins = {
		${pluginEntries},
		length: ${pluginList.length},
		item: function(i) { return this[i] || null; },
		namedItem: function(name) { return Object.values(this).find(p => p && p.name === name) || null; },
		refresh: function() {},
		[Symbol.iterator]: function*() { for (let i = 0; i < this.length; i++) yield this[i]; }
	};
	Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });
	Object.defineProperty(navigator, 'mimeTypes', { get: () => ({ length: 0, item: () => null, namedItem: () => null }) });

	// === WebGL (UNMASKED_VENDOR/RENDERER — Turnstile Layer 1, 8 properties) ===
	const __fp_webgl_vendor = ${JSON.stringify(webgl?.vendor ?? 'Apple Inc.')};
	const __fp_webgl_renderer = ${JSON.stringify(webgl?.renderer ?? 'Apple M1')};
	const __fp_webgl_version = ${JSON.stringify(webgl?.version ?? 'WebGL 1.0 (OpenGL ES 2.0 Chromium)')};
	const __fp_webgl_sl_version = ${JSON.stringify(webgl?.shadingLanguageVersion ?? 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)')};

	const getParameterProxy = {
		apply: function(target, thisArg, args) {
			const param = args[0];
			if (param === 37445) return __fp_webgl_vendor;   // UNMASKED_VENDOR_WEBGL
			if (param === 37446) return __fp_webgl_renderer; // UNMASKED_RENDERER_WEBGL
			if (param === 7938)  return __fp_webgl_version;  // VERSION
			if (param === 35724) return __fp_webgl_sl_version; // SHADING_LANGUAGE_VERSION
			return Reflect.apply(target, thisArg, args);
		}
	};
	const _origGetContext = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function(type) {
		const ctx = _origGetContext.apply(this, arguments);
		if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
			ctx.getParameter = new Proxy(ctx.getParameter, getParameterProxy);
		}
		return ctx;
	};
	if (typeof OffscreenCanvas !== 'undefined') {
		const _origOff = OffscreenCanvas.prototype.getContext;
		OffscreenCanvas.prototype.getContext = function(type) {
			const ctx = _origOff.apply(this, arguments);
			if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
				ctx.getParameter = new Proxy(ctx.getParameter, getParameterProxy);
			}
			return ctx;
		};
	}

	// === Screen ===
	${screenJs}

	// === Font Measurement Interception (Turnstile Layer 1 — hidden div font probe) ===
	${fontMapJs}
	if (__fp_fonts) {
		const _origGetBCR = Element.prototype.getBoundingClientRect;
		Element.prototype.getBoundingClientRect = function() {
			const s = window.getComputedStyle(this);
			if (s.visibility === 'hidden' && s.position === 'absolute') {
				const ff = s.fontFamily ? s.fontFamily.replace(/['"]/g, '').split(',')[0].trim() : null;
				if (ff && __fp_fonts[ff]) {
					const m = __fp_fonts[ff];
					return { width: m.width, height: m.height, top: 0, left: 0, bottom: m.height, right: m.width, x: 0, y: 0, toJSON: function() { return this; } };
				}
			}
			return _origGetBCR.apply(this, arguments);
		};
	}

	// === AudioContext fingerprint ===
	const _OrigAC = window.AudioContext || window.webkitAudioContext;
	if (_OrigAC) {
		const _AC = class extends _OrigAC {
			constructor() { super(...arguments); Object.defineProperty(this, 'sampleRate', { get: () => 44100 }); }
		};
		window.AudioContext = window.webkitAudioContext = _AC;
	}

	// === Battery API (macOS Chrome does not expose this) ===
	if (navigator.getBattery) { navigator.getBattery = undefined; }

	// === Connection API ===
	if (navigator.connection) {
		Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
		Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 });
		Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
	}

	// === Permissions API ===
	const _origQuery = navigator.permissions?.query;
	if (_origQuery) {
		navigator.permissions.query = function(p) {
			if (p.name === 'notifications') return Promise.resolve({ state: 'denied', onchange: null });
			return _origQuery.call(this, p);
		};
	}

	// === CDP screenX/screenY patch — Cloudflare Turnstile iframe bot check ===
	const _fakeScreenX = ${screenOffsetX};
	const _fakeScreenY = ${screenOffsetY};
	Object.defineProperty(MouseEvent.prototype, 'screenX', { get() { return this.clientX + _fakeScreenX; } });
	Object.defineProperty(MouseEvent.prototype, 'screenY', { get() { return this.clientY + _fakeScreenY; } });
	Object.defineProperty(PointerEvent.prototype, 'screenX', { get() { return this.clientX + _fakeScreenX; } });
	Object.defineProperty(PointerEvent.prototype, 'screenY', { get() { return this.clientY + _fakeScreenY; } });

	// === Application State ===
	${appStateJs}

	// ─── Hardening Post-Pass ──────────────────────────────────────────
	// Walk the property paths we just patched. For each one:
	//   1. Mark the getter as a fake native so Function.prototype.toString
	//      reports "function get NAME() { [native code] }".
	//   2. Wrap the getter so reads append to window.__fp_log_entries
	//      (the side-channel used by ChatGPTScriptInterceptor in log mode).
	// Doing this as a single post-pass lets the existing override blocks
	// stay readable as plain Object.defineProperty calls.
	const __fp_paths = [
		[navigator, ['platform','vendor','webdriver','languages','language','hardwareConcurrency','deviceMemory','maxTouchPoints','plugins','mimeTypes']],
		[screen,    ['colorDepth','pixelDepth','width','height','availWidth','availHeight','availLeft','availTop']],
	];
	if (navigator.connection) {
		__fp_paths.push([navigator.connection, ['effectiveType','downlink','rtt']]);
	}
	for (const entry of __fp_paths) {
		const target = entry[0];
		const props = entry[1];
		for (const prop of props) {
			try {
				const desc = Object.getOwnPropertyDescriptor(target, prop)
					|| Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target) || {}, prop);
				const orig = desc && desc.get ? desc.get : null;
				if (!orig) continue;
				// Wrap: log + delegate.
				const wrapped = function() {
					const v = orig.call(this);
					__fp_log('browser', prop, v);
					return v;
				};
				__fp_setNative(wrapped, 'get ' + prop);
				Reflect.defineProperty(target, prop, {
					get: wrapped,
					configurable: true,
					enumerable: desc ? !!desc.enumerable : true,
				});
			} catch(e) {}
		}
	}

	// Mark our WebGL getParameter Proxy as native too — it's the property
	// most aggressively introspected by Cloudflare Turnstile (Layer 1).
	try {
		const _testCtx = document.createElement('canvas').getContext('webgl');
		if (_testCtx && _testCtx.getParameter) {
			__fp_setNative(_testCtx.getParameter, 'getParameter');
		}
	} catch(e) {}

	// Logs that appear in window.__fp_log_entries are emitted to Node by
	// the separate __chatgpt_fp_log_drain init script (registered by
	// ChatGPTScriptInterceptor) via the __fp_emit_entries CDP binding.
})();`;
}

// ---------------------------------------------------------------------------
// ChatGPT-specific init script (generic + Signal Orchestrator pre-seeding)
// ---------------------------------------------------------------------------

/**
 * Builds the combined init script for chatgpt.com:
 *   1. Generic anti-detection (navigator, WebGL, screen, fonts, plugins, etc.)
 *   2. ChatGPT Signal Orchestrator pre-seeding (__oai_so_* properties)
 *
 * @param profile - Optional persona. Falls through to real browser values if omitted.
 */
export function buildChatGPTFingerprintScript(profile?: FingerprintProfile): string {
	const generic = buildFingerprintScript(profile);

	const beh = profile?.behavioral ?? {
		keystrokeIntervalMs: 130,
		keystrokeCount: 42,
		mouseVelocity: 0.68,
		mouseDistancePx: 3800,
		scrollCount: 7,
		scrollDistancePx: 1240,
		idleMs: 1200,
		pasteCount: 0,
		clickCount: 5,
	};

	const oaiSoScript = `
(function __oai_so_seed() {
	// === ChatGPT Signal Orchestrator — pre-seed window.__oai_so_* ===
	const _now = Date.now();
	window.__oai_so_kt_count = ${beh.keystrokeCount ?? 42};
	window.__oai_so_kt_last  = _now - ${beh.keystrokeIntervalMs ?? 130};
	window.__oai_so_kt_avg   = ${beh.keystrokeIntervalMs ?? 130};
	window.__oai_so_mv_dist  = ${beh.mouseDistancePx ?? 3800};
	window.__oai_so_mv_vel   = ${beh.mouseVelocity ?? 0.68};
	window.__oai_so_mv_last  = _now - 200;
	window.__oai_so_sc_count = ${beh.scrollCount ?? 7};
	window.__oai_so_sc_dist  = ${beh.scrollDistancePx ?? 1240};
	window.__oai_so_idle_ms  = ${beh.idleMs ?? 1200};
	window.__oai_so_paste    = ${beh.pasteCount ?? 0};
	window.__oai_so_click    = ${beh.clickCount ?? 5};
})();
`;

	return `${generic}\n${oaiSoScript}`;
}
