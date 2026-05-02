/**
 * Runtime API tap — research instrumentation for the build-nvidia hCaptcha
 * iframe and NVIDIA's React bundle.
 *
 * Installs an init script (via CdpScriptControl.registerInitScript, which
 * Chromium auto-propagates to OOPIFs) that wraps the native
 * EventTarget/timer APIs BEFORE any page or iframe script runs. When
 * hCaptcha's bundle later calls them, every registration and invocation
 * is recorded into a per-frame ring buffer.
 *
 * Property: NO bytes are modified. The hCaptcha inline.js (CSP/ECDSA
 * pinned) still validates — we hijack the native API surface that the
 * bundle later calls, not the bundle itself.
 *
 * Wrapped APIs:
 *   - EventTarget.prototype.addEventListener / removeEventListener
 *   - setTimeout / clearTimeout
 *   - setInterval / clearInterval
 *   - requestAnimationFrame / cancelAnimationFrame
 *
 * Cross-world data channel:
 *   The init script runs in the MAIN world. Patchright's `page.evaluate`
 *   and `frame.evaluate` run in an ISOLATED world that cannot see
 *   main-world `window.foo` globals. To bridge, the script appends each
 *   log entry as a JSON line to the `textContent` of a hidden
 *   `<script id="__bn_tap_data">` node — DOM nodes ARE shared across
 *   worlds. Drain reads the textContent and clears it.
 *
 * Throttling: invocations of mousemove/scroll/pointermove/wheel/touchmove
 * are limited to ~50ms per registration — high-frequency events would
 * otherwise blow out the buffer in seconds. Registrations and timer
 * fires are not throttled.
 */

import type { CdpScriptControl, InitScriptHandle } from '@interceptor/browser/remote';
import type { Page } from 'patchright';

const RUNTIME_TAP_SCRIPT = `(function () {
  try {
    if (window.__bn_tap_installed) return;
    window.__bn_tap_installed = true;

    var THROTTLE_MS = 50;
    var THROTTLED_TYPES = { mousemove: 1, scroll: 1, pointermove: 1, wheel: 1, touchmove: 1 };
    var MAX_NODE_LEN = 4000000; // ~4 MB per frame's data buffer

    var nextId = 1;

    // Lazy-init the data sink: a <script> element appended to <html>.
    // Its textContent is the cross-world channel; isolated world reads it.
    var dataNode = null;
    function getSink() {
      if (dataNode) return dataNode;
      try {
        var n = document.getElementById('__bn_tap_data');
        if (!n) {
          n = document.createElement('script');
          n.type = 'application/x-bn-tap';
          n.id = '__bn_tap_data';
          (document.documentElement || document.body || document).appendChild(n);
        }
        dataNode = n;
        return n;
      } catch (_) {
        return null;
      }
    }

    function push(entry) {
      try {
        var sink = getSink();
        if (!sink) return;
        var line = JSON.stringify(entry) + '\\n';
        sink.appendChild(document.createTextNode(line));
        // Cap: if total textContent exceeds limit, drop oldest text nodes
        // until under cap. textContent reads are O(n) so check sparingly.
        if (sink.childNodes.length % 200 === 0) {
          var len = sink.textContent ? sink.textContent.length : 0;
          while (len > MAX_NODE_LEN && sink.firstChild) {
            len -= sink.firstChild.textContent ? sink.firstChild.textContent.length : 0;
            sink.removeChild(sink.firstChild);
          }
        }
      } catch (_) {}
    }

    function srcFromStack() {
      try {
        var s = new Error().stack || '';
        var lines = s.split('\\n');
        for (var i = 0; i < lines.length; i++) {
          var L = lines[i];
          if (!L) continue;
          if (L.indexOf('runtime-tap') >= 0) continue;
          if (L.indexOf('__bn_tap') >= 0) continue;
          if (L.indexOf('Error') === 0) continue;
          var m = L.match(/\\(?(https?:[^\\s)]+|chrome-[^\\s)]+|blob:[^\\s)]+):(\\d+):(\\d+)\\)?/);
          if (m) return m[1] + ':' + m[2];
        }
        return '<unknown>';
      } catch (_) { return '<stack-error>'; }
    }

    function tagOf(el) {
      try {
        if (!el) return null;
        if (el === window) return '#window';
        if (el === document) return '#document';
        if (el.nodeName) {
          var t = el.nodeName.toLowerCase();
          if (el.id) t += '#' + el.id;
          else if (el.className && typeof el.className === 'string')
            t += '.' + el.className.split(/\\s+/).slice(0, 2).join('.');
          return t;
        }
        return String((el.constructor && el.constructor.name) || '?');
      } catch (_) { return '?'; }
    }

    function eventSummary(e) {
      try {
        var s = { type: e.type, isTrusted: !!e.isTrusted };
        if ('key' in e) s.key = e.key;
        if ('code' in e) s.code = e.code;
        if ('clientX' in e) { s.x = e.clientX; s.y = e.clientY; }
        if ('button' in e) s.button = e.button;
        if ('deltaY' in e) s.dy = e.deltaY;
        s.tgt = tagOf(e.target);
        s.cur = tagOf(e.currentTarget);
        return s;
      } catch (_) { return { type: '?' }; }
    }

    // ── EventTarget.prototype.addEventListener / removeEventListener ──
    var EP = (window.EventTarget && window.EventTarget.prototype) || null;
    if (EP && EP.addEventListener && EP.removeEventListener) {
      var origAdd = EP.addEventListener;
      var origRem = EP.removeEventListener;
      var registry = new WeakMap(); // target → { 'type|cap' → Map(listener → {regId,wrapped}) }

      function getReg(target) {
        var r = registry.get(target);
        if (!r) { r = Object.create(null); registry.set(target, r); }
        return r;
      }

      function captureFlag(opts) {
        if (opts === true || opts === false) return !!opts;
        if (opts && typeof opts === 'object') return !!opts.capture;
        return false;
      }

      EP.addEventListener = function (type, listener, options) {
        try {
          var isFn = typeof listener === 'function';
          var isObj = listener && typeof listener.handleEvent === 'function';
          if (!isFn && !isObj) return origAdd.call(this, type, listener, options);

          var cap = captureFlag(options);
          var key = type + '|' + (cap ? 'C' : 'B');
          var r = getReg(this);
          if (!r[key]) r[key] = new Map();
          if (r[key].has(listener)) {
            // Already wrapped (e.g. duplicate add) — don't double-wrap.
            return origAdd.call(this, type, listener, options);
          }

          var regId = nextId++;
          var src = srcFromStack();
          var lastInvoke = 0;
          var fn = isFn ? listener : listener.handleEvent.bind(listener);

          var wrapped = function (ev) {
            var t0 = performance.now();
            var throttled = THROTTLED_TYPES[type] === 1;
            var doLog = !throttled || (t0 - lastInvoke) >= THROTTLE_MS;
            if (doLog) lastInvoke = t0;
            var ret;
            try {
              ret = fn.apply(this, arguments);
            } finally {
              if (doLog) {
                push({
                  kind: 'invoke', api: 'addEventListener',
                  t: t0, regId: regId, type: type,
                  durMs: +(performance.now() - t0).toFixed(3),
                  evt: eventSummary(ev),
                });
              }
            }
            return ret;
          };

          r[key].set(listener, { regId: regId, wrapped: wrapped });

          push({
            kind: 'register', api: 'addEventListener',
            t: performance.now(), regId: regId, type: type,
            cap: cap, target: tagOf(this), src: src,
          });

          return origAdd.call(this, type, wrapped, options);
        } catch (_) {
          return origAdd.call(this, type, listener, options);
        }
      };

      EP.removeEventListener = function (type, listener, options) {
        try {
          var cap = captureFlag(options);
          var key = type + '|' + (cap ? 'C' : 'B');
          var r = registry.get(this);
          var entry = r && r[key] && r[key].get(listener);
          if (entry) {
            r[key].delete(listener);
            push({
              kind: 'remove', api: 'removeEventListener',
              t: performance.now(), regId: entry.regId, type: type,
              target: tagOf(this), cap: cap,
            });
            return origRem.call(this, type, entry.wrapped, options);
          }
        } catch (_) {}
        return origRem.call(this, type, listener, options);
      };
    }

    // ── setTimeout / clearTimeout ─────────────────────────────────────
    var origST = window.setTimeout;
    var origCT = window.clearTimeout;
    if (origST && origCT) {
      var stMap = new Map();
      window.setTimeout = function (cb, delay) {
        try {
          if (typeof cb === 'function') {
            var regId = nextId++;
            var src = srcFromStack();
            var args = Array.prototype.slice.call(arguments, 2);
            var wrapped = function () {
              var t0 = performance.now();
              try { return cb.apply(this, arguments); }
              finally {
                push({ kind: 'invoke', api: 'setTimeout', t: t0, regId: regId,
                  durMs: +(performance.now() - t0).toFixed(3) });
                stMap.delete(handle);
              }
            };
            var handle = origST.apply(this, [wrapped, delay].concat(args));
            stMap.set(handle, regId);
            push({ kind: 'register', api: 'setTimeout', t: performance.now(),
              regId: regId, delay: delay, src: src });
            return handle;
          }
        } catch (_) {}
        return origST.apply(this, arguments);
      };
      window.clearTimeout = function (h) {
        try {
          var regId = stMap.get(h);
          if (regId !== undefined) {
            push({ kind: 'remove', api: 'clearTimeout', t: performance.now(), regId: regId });
            stMap.delete(h);
          }
        } catch (_) {}
        return origCT.call(this, h);
      };
    }

    // ── setInterval / clearInterval ───────────────────────────────────
    var origSI = window.setInterval;
    var origCI = window.clearInterval;
    if (origSI && origCI) {
      var siMap = new Map();
      window.setInterval = function (cb, delay) {
        try {
          if (typeof cb === 'function') {
            var regId = nextId++;
            var src = srcFromStack();
            var args = Array.prototype.slice.call(arguments, 2);
            var fireCount = 0;
            var wrapped = function () {
              var t0 = performance.now();
              fireCount++;
              try { return cb.apply(this, arguments); }
              finally {
                // Only log every 5th fire after the first 3 — intervals can run forever
                if (fireCount <= 3 || fireCount % 5 === 0) {
                  push({ kind: 'invoke', api: 'setInterval', t: t0, regId: regId,
                    fire: fireCount,
                    durMs: +(performance.now() - t0).toFixed(3) });
                }
              }
            };
            var handle = origSI.apply(this, [wrapped, delay].concat(args));
            siMap.set(handle, regId);
            push({ kind: 'register', api: 'setInterval', t: performance.now(),
              regId: regId, delay: delay, src: src });
            return handle;
          }
        } catch (_) {}
        return origSI.apply(this, arguments);
      };
      window.clearInterval = function (h) {
        try {
          var regId = siMap.get(h);
          if (regId !== undefined) {
            push({ kind: 'remove', api: 'clearInterval', t: performance.now(), regId: regId });
            siMap.delete(h);
          }
        } catch (_) {}
        return origCI.call(this, h);
      };
    }

    // ── requestAnimationFrame / cancelAnimationFrame ──────────────────
    // rAF is called continuously by anything doing animation/sampling.
    // Log only the first registration per source URL, and every 60th invoke
    // per source (≈1/sec at 60fps), to avoid drowning the buffer.
    var origRAF = window.requestAnimationFrame;
    var origCAF = window.cancelAnimationFrame;
    if (origRAF && origCAF) {
      var seenRAFSrc = Object.create(null);
      var rafCountBySrc = Object.create(null);
      window.requestAnimationFrame = function (cb) {
        try {
          if (typeof cb === 'function') {
            var src = srcFromStack();
            var firstSeen = !seenRAFSrc[src];
            if (firstSeen) {
              seenRAFSrc[src] = nextId++;
              push({ kind: 'register', api: 'requestAnimationFrame',
                t: performance.now(), regId: seenRAFSrc[src], src: src });
            }
            var regId = seenRAFSrc[src];
            var wrapped = function (ts) {
              var t0 = performance.now();
              try { return cb.call(this, ts); }
              finally {
                rafCountBySrc[src] = (rafCountBySrc[src] || 0) + 1;
                var n = rafCountBySrc[src];
                if (n === 1 || n % 60 === 0) {
                  push({ kind: 'invoke', api: 'requestAnimationFrame',
                    t: t0, regId: regId, sample: n,
                    durMs: +(performance.now() - t0).toFixed(3) });
                }
              }
            };
            return origRAF.call(this, wrapped);
          }
        } catch (_) {}
        return origRAF.apply(this, arguments);
      };
      // No instrumentation on cancel — rAF cancellations don't carry a meaningful regId in our model.
    }

    // ── window.fetch ──────────────────────────────────────────────────
    // Hooks the iframe's own fetch too, since this script auto-propagates
    // to OOPIFs. That's how we see the hCaptcha api.hcaptcha.com POST
    // body (it originates inside the iframe, invisible to parent hooks).
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          var method = (init && init.method) || (input && input.method) || 'GET';
          var hdrs = {};
          var src = (init && init.headers) || (input && input.headers) || null;
          if (src && typeof src.forEach === 'function') {
            src.forEach(function (v, k) { hdrs[k] = v; });
          } else if (src && typeof src === 'object') {
            Object.keys(src).forEach(function (k) { hdrs[k] = src[k]; });
          }
          var bodyPreview = null;
          var b = init && init.body;
          if (typeof b === 'string') {
            bodyPreview = b.length > 4000 ? b.slice(0, 4000) + '...[' + b.length + ']' : b;
          } else if (b && b.constructor) {
            bodyPreview = '[' + b.constructor.name + ']';
          }
          var regId = nextId++;
          var t0 = performance.now();
          push({
            kind: 'register', api: 'fetch', t: t0, regId: regId,
            url: url, method: method, headers: hdrs, body: bodyPreview,
            src: srcFromStack(),
          });
          var p = origFetch.apply(this, arguments);
          p.then(function (r) {
            try {
              var rh = {};
              r.headers && r.headers.forEach && r.headers.forEach(function (v, k) { rh[k] = v; });
              push({
                kind: 'invoke', api: 'fetch', t: performance.now(), regId: regId,
                url: url, status: r.status, durMs: +(performance.now() - t0).toFixed(3),
                headers: rh,
              });
            } catch (_) {}
          }, function (e) {
            push({ kind: 'invoke', api: 'fetch', t: performance.now(), regId: regId,
              url: url, error: String((e && e.message) || e) });
          });
          return p;
        } catch (_) {}
        return origFetch.apply(this, arguments);
      };
    }

    // ── XMLHttpRequest ────────────────────────────────────────────────
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      var origSetHdr = XHR.prototype.setRequestHeader;
      XHR.prototype.open = function (m, u) {
        try { this.__bn_xhr = { url: u, method: m, headers: {}, t0: 0, regId: nextId++ }; } catch (_) {}
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.setRequestHeader = function (k, v) {
        try { if (this.__bn_xhr) this.__bn_xhr.headers[k] = v; } catch (_) {}
        return origSetHdr.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        try {
          if (this.__bn_xhr) {
            this.__bn_xhr.t0 = performance.now();
            var bp = null;
            if (typeof body === 'string') {
              bp = body.length > 4000 ? body.slice(0, 4000) + '...[' + body.length + ']' : body;
            } else if (body && body.constructor) {
              bp = '[' + body.constructor.name + ']';
            }
            push({
              kind: 'register', api: 'xhr', t: performance.now(), regId: this.__bn_xhr.regId,
              url: this.__bn_xhr.url, method: this.__bn_xhr.method,
              headers: this.__bn_xhr.headers, body: bp,
              src: srcFromStack(),
            });
            var self = this;
            this.addEventListener('loadend', function () {
              try {
                push({
                  kind: 'invoke', api: 'xhr', t: performance.now(), regId: self.__bn_xhr.regId,
                  url: self.__bn_xhr.url, status: self.status,
                  durMs: +(performance.now() - self.__bn_xhr.t0).toFixed(3),
                });
              } catch (_) {}
            });
          }
        } catch (_) {}
        return origSend.apply(this, arguments);
      };
    }

    // Marker so the host can confirm the script reached this realm.
    try {
      document.documentElement.setAttribute(
        'data-bn-tap', String(performance.now().toFixed(0))
      );
    } catch (_) {}
  } catch (outerErr) {
    try {
      document.documentElement.setAttribute(
        'data-bn-tap-err',
        String((outerErr && outerErr.message) || outerErr).slice(0, 200)
      );
    } catch (_) {}
  }
})();`;

export interface RuntimeTapEntry {
	kind: 'register' | 'invoke' | 'remove';
	api: string;
	t: number;
	regId?: number;
	type?: string;
	cap?: boolean;
	target?: string;
	src?: string;
	delay?: number;
	durMs?: number;
	sample?: number;
	fire?: number;
	evt?: {
		type: string;
		isTrusted: boolean;
		key?: string;
		code?: string;
		x?: number;
		y?: number;
		button?: number;
		dy?: number;
		tgt?: string;
		cur?: string;
	};
	// fetch / xhr fields
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	status?: number;
	error?: string;
}

export interface RuntimeTapDrain {
	/** Per-frame buckets keyed by frame URL. */
	frames: Record<string, RuntimeTapEntry[]>;
	/** Total entries across all frames. */
	total: number;
	/** Frames discovered at drain time (for diagnostics — includes empty ones). */
	frameUrls: string[];
	/** Frames that errored on drain (cross-origin denial, navigation in flight, etc.). */
	frameErrors: Record<string, string>;
}

export async function attachRuntimeTap(control: CdpScriptControl): Promise<InitScriptHandle> {
	return control.registerInitScript(RUNTIME_TAP_SCRIPT);
}

export async function detachRuntimeTap(
	control: CdpScriptControl,
	handle: InitScriptHandle,
): Promise<void> {
	await control.unregisterInitScript(handle).catch(() => {});
}

/**
 * Drain the per-frame data sinks. The init script appends each entry as a
 * JSON line to the textContent of `<script id="__bn_tap_data">`. We read
 * that node from the isolated world (DOM is shared across worlds), parse,
 * and clear the node so the next drain only sees new entries.
 */
export async function drainRuntimeTap(page: Page): Promise<RuntimeTapDrain> {
	const out: Record<string, RuntimeTapEntry[]> = {};
	const errors: Record<string, string> = {};
	const frameUrls: string[] = [];

	const drainFn = `(function () {
		try {
			var n = document.getElementById('__bn_tap_data');
			if (!n) return null;
			var txt = n.textContent || '';
			// Clear by removing all children, not by reassigning textContent
			// (reassign would race with main-world appendChild calls).
			while (n.firstChild) n.removeChild(n.firstChild);
			return txt;
		} catch (e) { return '\\n__ERR:' + (e && e.message || e); }
	})()`;

	for (const frame of page.frames()) {
		const url = frame.url() || '<about:blank>';
		frameUrls.push(url);
		try {
			const raw = (await frame.evaluate(drainFn)) as string | null;
			if (raw === null) continue;
			if (raw.startsWith('\n__ERR:')) {
				errors[url] = raw.slice(7);
				continue;
			}
			const lines = raw.split('\n').filter((s) => s.length > 0);
			const entries: RuntimeTapEntry[] = [];
			for (const line of lines) {
				try {
					entries.push(JSON.parse(line) as RuntimeTapEntry);
				} catch {
					// Truncated line at the cap boundary — drop.
				}
			}
			if (entries.length > 0) {
				// Multiple frames may share a URL (e.g. about:blank); accumulate.
				if (out[url]) out[url].push(...entries);
				else out[url] = entries;
			}
		} catch (err) {
			errors[url] = err instanceof Error ? err.message : String(err);
		}
	}

	let total = 0;
	for (const arr of Object.values(out)) total += arr.length;
	return { frames: out, total, frameUrls, frameErrors: errors };
}
