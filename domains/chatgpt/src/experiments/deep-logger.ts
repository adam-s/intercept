/**
 * Deep Logger — pre-evaluation instrumentation for ChatGPT/Sentinel analysis.
 *
 * Installed via `Page.addScriptToEvaluateOnNewDocument` so it runs in the
 * main world BEFORE any page or iframe script. Hooks every meaningful
 * transport / state primitive and writes structured log entries to
 * `top.__deep_log` (same-origin frames share `top`).
 *
 * EXPERIMENTAL — for reverse-engineering only. Not production.
 *
 * What's logged:
 *   - fetch(): url, method, headers, body, status, response-size, response
 *     (truncated). One pre-flight entry, one post-flight entry.
 *   - XMLHttpRequest: open(), setRequestHeader(), send(), onreadystatechange
 *     transitions, response on done.
 *   - postMessage: targetOrigin + payload preview, both send and receive.
 *   - document.cookie: read + write events (writes log the cookie value;
 *     reads log a count and the prefix of the returned string).
 *   - localStorage / sessionStorage: setItem, getItem, removeItem, clear.
 *   - crypto.subtle: every async op (sign, verify, encrypt, decrypt,
 *     importKey, exportKey, deriveKey, deriveBits, generateKey, digest)
 *     with its inputs (hashed for keys, truncated for data) and output
 *     fingerprint.
 *   - btoa / atob: input + output, truncated.
 *   - TextEncoder / TextDecoder: input + output, truncated.
 *   - Math.imul: count only (too noisy to log per-call).
 *   - SentinelSDK: when first defined, every method on the namespace gets
 *     wrapped to log args + return value + duration.
 *   - Module loaders: dynamic `import()` and `<script>` insertions.
 *
 * Output: append-only `top.__deep_log` array. Each entry:
 *   { seq, t, frame, type, op, args?, result?, stack? }
 *
 * Drain: read `top.__deep_log` from the top-level page; truncate by
 * setting `top.__deep_log_offset = top.__deep_log.length` after dump.
 */

export const DEEP_LOGGER_SCRIPT = `
(function __chatgpt_deep_logger() {
	// Idempotency guard: use a DOM-attribute check (DOM is shared across
	// JS worlds; window globals are NOT). Without this, init scripts that
	// run in both Patchright's isolated world and the page's main world
	// would each try to install — and since the previous version of this
	// guard used a window flag, the *second* world would (incorrectly) see
	// the flag from neither world and re-enter, but DOM-attribute checks
	// reflect the actual install state across worlds.
	try {
		if (document && document.documentElement) {
			if (document.documentElement.getAttribute('data-deep-logger-installed') === '1') return;
			document.documentElement.setAttribute('data-deep-logger-installed', '1');
		}
	} catch (e) { return; }
	window.__deep_logger_installed = true;

	// ─── Shared log buffer on the top-level window ──────────────────
	// Same-origin iframes (sentinel/frame.html) share top with the parent.
	const TOP = (() => {
		try { return window.top; } catch (e) { return window; }
	})();

	if (!TOP.__deep_log) {
		TOP.__deep_log = [];
		TOP.__deep_log_seq = 0;
	}

	const FRAME = (() => {
		try {
			if (window === TOP) return 'top';
			return location.href.slice(0, 80);
		} catch (e) { return 'unknown'; }
	})();

	function trunc(v, max) {
		max = max || 4000;
		try {
			if (v == null) return v;
			if (typeof v === 'string') return v.length > max ? v.slice(0, max) + '…(' + v.length + ')' : v;
			if (v instanceof ArrayBuffer) return '<ArrayBuffer ' + v.byteLength + '>';
			if (ArrayBuffer.isView(v)) return '<' + v.constructor.name + ' ' + v.byteLength + '>';
			if (v instanceof Blob) return '<Blob ' + v.size + ' ' + v.type + '>';
			if (v instanceof FormData) return '<FormData>';
			if (typeof v === 'object') {
				const s = JSON.stringify(v);
				return s.length > max ? s.slice(0, max) + '…(' + s.length + ')' : s;
			}
			return String(v);
		} catch (e) { return '<unstringifiable>'; }
	}

	function shortStack() {
		try {
			const e = new Error();
			const lines = (e.stack || '').split('\\n').slice(2, 5);
			return lines.map(l => l.trim()).join(' ← ');
		} catch (e) { return ''; }
	}

	// In-memory buffer in main-world TOP. We ALSO push every entry to
	// window.__deep_emit(json) — a CDP-bound function exposed from Node —
	// because Patchright evaluate runs in an isolated world that cannot
	// see main-world window properties, so top.__deep_log is invisible
	// to evaluate-based drains. The binding bypasses worlds (registered
	// at the page level).
	function emit(type, op, payload) {
		try {
			const seq = ++TOP.__deep_log_seq;
			const entry = { seq, t: Date.now(), frame: FRAME, type, op, ...payload };
			TOP.__deep_log.push(entry);
			// Best-effort emit to Node. The binding may not be installed
			// yet; the drain endpoint also reads top.__deep_log via main-
			// world evaluate as a fallback for entries logged before the
			// binding existed.
			if (typeof window.__deep_emit === 'function') {
				try { window.__deep_emit(JSON.stringify(entry)); } catch (e) {}
			}
		} catch (e) { /* never break the page */ }
	}

	// ─── Request constructor (capture bodies passed via new Request) ──
	try {
		const OrigRequest = window.Request;
		window.Request = new Proxy(OrigRequest, {
			construct(target, args) {
				const r = new target(...args);
				const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '?');
				const init = args[1] || {};
				emit('Request', 'construct', {
					url: trunc(url, 200),
					method: (init.method || (args[0]?.method) || 'GET'),
					headers: trunc(init.headers, 16000),
					body: trunc(init.body, 8000),
					stack: shortStack(),
				});
				return r;
			}
		});
	} catch (e) {}

	// ─── window.fetch ───────────────────────────────────────────────
	const origFetch = window.fetch;
	window.fetch = function fetch(input, init) {
		const url = typeof input === 'string' ? input : (input && input.url) || String(input);
		const method = (init && init.method) || (input && input.method) || 'GET';
		const headers = (init && init.headers) || (input && input.headers);
		// Body can come from init.body OR from input (when input is a Request).
		const body = (init && init.body) ?? (input && typeof input === 'object' && input.body);
		const isRequestInput = input && typeof input === 'object' && input.constructor && input.constructor.name === 'Request';
		emit('fetch', 'request', {
			url: trunc(url, 200),
			method,
			headers: trunc(headers, 16000),
			body: trunc(body, 8000),
			isRequestInput,
			stack: shortStack(),
		});
		return origFetch.apply(this, arguments).then(res => {
			emit('fetch', 'response', {
				url: trunc(url, 200), status: res.status, contentType: res.headers.get('content-type'),
			});
			return res;
		}, err => {
			emit('fetch', 'error', { url: trunc(url, 200), error: trunc(err && err.message) });
			throw err;
		});
	};

	// ─── XMLHttpRequest ─────────────────────────────────────────────
	const xhrOpen = XMLHttpRequest.prototype.open;
	const xhrSend = XMLHttpRequest.prototype.send;
	const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
	XMLHttpRequest.prototype.open = function (method, url) {
		this.__dl_method = method; this.__dl_url = url; this.__dl_headers = {};
		emit('xhr', 'open', { url: trunc(url, 200), method, stack: shortStack() });
		return xhrOpen.apply(this, arguments);
	};
	XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
		try { this.__dl_headers[k] = v; } catch (e) {}
		return xhrSetHeader.apply(this, arguments);
	};
	XMLHttpRequest.prototype.send = function (body) {
		const me = this;
		emit('xhr', 'send', {
			url: trunc(me.__dl_url, 200), method: me.__dl_method,
			headers: trunc(me.__dl_headers, 16000), body: trunc(body, 8000),
		});
		me.addEventListener('readystatechange', function () {
			if (me.readyState === 4) {
				emit('xhr', 'done', {
					url: trunc(me.__dl_url, 200), status: me.status,
					responseLen: (me.responseText || '').length,
					responseHead: trunc(me.responseText, 8000),
				});
			}
		});
		return xhrSend.apply(this, arguments);
	};

	// ─── postMessage send + receive ──────────────────────────────────
	const origPM = window.postMessage;
	window.postMessage = function (msg, target) {
		emit('postMessage', 'send', { target: trunc(target), msg: trunc(msg, 800), stack: shortStack() });
		return origPM.apply(this, arguments);
	};
	window.addEventListener('message', (ev) => {
		emit('postMessage', 'recv', {
			origin: ev.origin, source: ev.source === window ? 'self' : 'other',
			data: trunc(ev.data, 4000),
		});
	}, true);

	// ─── document.cookie ────────────────────────────────────────────
	try {
		const origDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
		if (origDesc && origDesc.get && origDesc.set) {
			Object.defineProperty(Document.prototype, 'cookie', {
				get: function () {
					const v = origDesc.get.call(this);
					emit('cookie', 'read', { len: (v || '').length, head: trunc(v, 200) });
					return v;
				},
				set: function (v) {
					emit('cookie', 'write', { value: trunc(v, 2000), stack: shortStack() });
					return origDesc.set.call(this, v);
				},
				configurable: true,
			});
		}
	} catch (e) { emit('cookie', 'hook-error', { error: trunc(e && e.message) }); }

	// ─── Storage ─────────────────────────────────────────────────────
	function hookStorage(name, store) {
		const orig = {
			getItem: store.getItem.bind(store),
			setItem: store.setItem.bind(store),
			removeItem: store.removeItem.bind(store),
			clear: store.clear.bind(store),
		};
		store.getItem = function (k) {
			const v = orig.getItem(k);
			emit(name, 'getItem', { key: k, len: (v || '').length, val: trunc(v, 4000) });
			return v;
		};
		store.setItem = function (k, v) {
			emit(name, 'setItem', { key: k, val: trunc(v, 4000), stack: shortStack() });
			return orig.setItem(k, v);
		};
		store.removeItem = function (k) {
			emit(name, 'removeItem', { key: k });
			return orig.removeItem(k);
		};
		store.clear = function () {
			emit(name, 'clear', {});
			return orig.clear();
		};
	}
	try { hookStorage('localStorage', window.localStorage); } catch (e) {}
	try { hookStorage('sessionStorage', window.sessionStorage); } catch (e) {}

	// ─── crypto.subtle ───────────────────────────────────────────────
	try {
		const subtle = window.crypto && window.crypto.subtle;
		if (subtle) {
			const ops = ['sign', 'verify', 'encrypt', 'decrypt', 'importKey',
				'exportKey', 'deriveKey', 'deriveBits', 'generateKey', 'digest', 'wrapKey', 'unwrapKey'];
			for (const op of ops) {
				const orig = subtle[op] && subtle[op].bind(subtle);
				if (!orig) continue;
				subtle[op] = function () {
					const args = Array.from(arguments);
					emit('subtle', op + '_call', {
						algo: trunc(args[0], 4000),
						keyOrData: args.length > 1 ? trunc(args[1], 4000) : null,
						extra: args.length > 2 ? trunc(args.slice(2), 4000) : null,
						stack: shortStack(),
					});
					return orig.apply(this, args).then(res => {
						emit('subtle', op + '_result', { result: trunc(res, 200) });
						return res;
					}, err => {
						emit('subtle', op + '_error', { error: trunc(err && err.message) });
						throw err;
					});
				};
			}
		}
	} catch (e) { emit('subtle', 'hook-error', { error: trunc(e && e.message) }); }

	// ─── btoa / atob ────────────────────────────────────────────────
	const origBtoa = window.btoa;
	const origAtob = window.atob;
	window.btoa = function (s) {
		const r = origBtoa.call(this, s);
		emit('base64', 'btoa', { in: trunc(s, 8000), out: trunc(r, 8000) });
		return r;
	};
	window.atob = function (s) {
		const r = origAtob.call(this, s);
		emit('base64', 'atob', { in: trunc(s, 8000), out: trunc(r, 8000) });
		return r;
	};

	// ─── TextEncoder / TextDecoder ──────────────────────────────────
	try {
		const origEncode = TextEncoder.prototype.encode;
		TextEncoder.prototype.encode = function (s) {
			const r = origEncode.call(this, s);
			emit('text', 'encode', { in: trunc(s, 200), outLen: r && r.byteLength });
			return r;
		};
		const origDecode = TextDecoder.prototype.decode;
		TextDecoder.prototype.decode = function (b) {
			const r = origDecode.call(this, b);
			emit('text', 'decode', { inLen: b && b.byteLength, out: trunc(r, 200) });
			return r;
		};
	} catch (e) {}

	// ─── Math.imul (count only) ─────────────────────────────────────
	try {
		const origImul = Math.imul;
		let imulCount = 0;
		Math.imul = function (a, b) {
			imulCount++;
			if (imulCount === 1 || imulCount % 1000 === 0) {
				emit('math', 'imul_count', { count: imulCount });
			}
			return origImul(a, b);
		};
	} catch (e) {}

	// ─── Watch for SentinelSDK definition ────────────────────────────
	let sdkWatched = false;
	(function watchSDK() {
		if (sdkWatched) return;
		try {
			if (window.SentinelSDK && typeof window.SentinelSDK === 'object') {
				sdkWatched = true;
				const sdk = window.SentinelSDK;
				const keys = Object.keys(sdk);
				emit('sdk', 'detected', { frame: FRAME, keys, types: keys.map(k => typeof sdk[k]) });
				for (const k of keys) {
					const v = sdk[k];
					if (typeof v !== 'function') continue;
					const orig = v.bind(sdk);
					sdk[k] = function () {
						const t0 = performance.now();
						const args = Array.from(arguments);
						emit('sdk', k + '_call', {
							args: args.map(a => trunc(a, 2000)),
							argTypes: args.map(a => typeof a),
							stack: shortStack(),
						});
						let r;
						try { r = orig.apply(this, args); }
						catch (e) { emit('sdk', k + '_throw', { error: trunc(e && e.message) }); throw e; }
						if (r && typeof r.then === 'function') {
							return r.then(rr => {
								emit('sdk', k + '_resolve', {
									dur: Math.round(performance.now() - t0), result: trunc(rr, 200),
								});
								return rr;
							}, ee => {
								emit('sdk', k + '_reject', { error: trunc(ee && ee.message) });
								throw ee;
							});
						}
						emit('sdk', k + '_return', {
							dur: Math.round(performance.now() - t0), result: trunc(r, 200),
						});
						return r;
					};
				}
			}
		} catch (e) {}
		setTimeout(watchSDK, 200);
	})();

	// ─── Module loader / dynamic script insertion ───────────────────
	try {
		const origCreateElement = Document.prototype.createElement;
		Document.prototype.createElement = function (tag) {
			const el = origCreateElement.apply(this, arguments);
			if (String(tag).toLowerCase() === 'script') {
				let _src = '';
				Object.defineProperty(el, 'src', {
					get: function () { return _src; },
					set: function (v) { emit('script', 'create', { src: trunc(v, 200), stack: shortStack() }); _src = v; el.setAttribute('src', v); },
					configurable: true,
				});
			}
			return el;
		};
	} catch (e) {}

	emit('logger', 'installed', { frame: FRAME, ua: navigator.userAgent.slice(0, 80) });

	// Diagnostic: record on documentElement what the logger could see at
	// install time. This lets us confirm whether the page binding was
	// reachable from the main world without going through emit().
	try {
		document.documentElement.setAttribute(
			'data-deep-logger-diag',
			JSON.stringify({
				hasEmit: typeof window.__deep_emit,
				bufLen: TOP.__deep_log.length,
				url: location.href.slice(0, 60),
			}),
		);
	} catch (e) {}
})();
`;
