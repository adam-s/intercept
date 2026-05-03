/**
 * E7 — focused XHR/fetch tap for the hCaptcha iframe.
 *
 * The general-purpose runtime-tap redacts XHR/fetch bodies as `"[r]"`
 * because indiscriminate full-body capture inside NVIDIA's main-world
 * surface would explode the buffer. For E7 we need the EXACT bytes flying
 * between the iframe and `api.hcaptcha.com` — getcaptcha request body
 * (msgpack fingerprint), getcaptcha response (msgpack spec including
 * `payload.l` / `i` / `n` / `req`), and the eventual `check` (or
 * `siteverify`) round-trip that yields the `P1_…` token.
 *
 * Init script auto-propagates to OOPIFs. We only stash entries when the
 * URL host contains `hcaptcha.com` — keeps the channel quiet on the
 * NVIDIA parent. Bodies are base64-encoded into a hidden
 * `<script id="__bn_hcap_xhr_data">` textContent (the same DOM-channel
 * pattern as runtime-tap; main-world `window.foo` is invisible to the
 * isolated world Patchright drains from).
 *
 * Property: NO bytes mutated, no upstream behaviour changed. Wraps native
 * APIs around the bundle, not inside it. inline.js's CSP/ECDSA self-check
 * still validates.
 */

import type { CdpScriptControl, InitScriptHandle } from '@interceptor/browser/remote';
import type { Page } from 'patchright';

const HCAP_TAP_SCRIPT = `(function() {
  try {
    if (window.__bn_hcap_tap_installed) return;
    window.__bn_hcap_tap_installed = true;
    var SINK_ID = '__bn_hcap_xhr_data';
    var MAX = 8 * 1024 * 1024;

    function getSink() {
      var s = document.getElementById(SINK_ID);
      if (!s) {
        s = document.createElement('script');
        s.id = SINK_ID;
        s.type = 'application/json';
        s.textContent = '';
        (document.documentElement || document.head || document.body).appendChild(s);
      }
      return s;
    }
    function push(entry) {
      try {
        var s = getSink();
        var line = JSON.stringify(entry);
        if ((s.textContent.length + line.length + 1) > MAX) return;
        s.textContent = s.textContent + line + '\\n';
      } catch (e) { /* swallow */ }
    }
    function isHcap(u) {
      try {
        var url = new URL(String(u), location.href);
        return /hcaptcha\\.com$/i.test(url.host) || /hcaptcha\\.com$/i.test(url.hostname);
      } catch (e) { return false; }
    }
    function bytesToB64(buf) {
      try {
        if (typeof buf === 'string') {
          // utf8 string -> base64
          return btoa(unescape(encodeURIComponent(buf)));
        }
        if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
        if (buf instanceof Uint8Array) {
          var s = '';
          for (var i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
          return btoa(s);
        }
      } catch (e) { /* fallthrough */ }
      return null;
    }
    function getRespBody(xhr) {
      try {
        if (xhr.responseType === 'arraybuffer') return bytesToB64(xhr.response);
        if (xhr.responseType === 'blob') return null; // can't read sync
        if (xhr.responseType === 'json') {
          try { return bytesToB64(JSON.stringify(xhr.response)); } catch (e) {}
        }
        if (typeof xhr.responseText === 'string') return bytesToB64(xhr.responseText);
        // arraybuffer fallback
        if (xhr.response && xhr.response.constructor === ArrayBuffer) return bytesToB64(xhr.response);
      } catch (e) {}
      return null;
    }

    // ─── XMLHttpRequest ──────────────────────────────────────────────
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      var origSetHdr = XHR.prototype.setRequestHeader;
      XHR.prototype.open = function (method, url) {
        try {
          this.__bn_meta = { method: String(method), url: String(url), headers: {}, t0: Date.now() };
        } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.setRequestHeader = function (k, v) {
        try {
          if (this.__bn_meta) this.__bn_meta.headers[String(k).toLowerCase()] = String(v);
        } catch (e) {}
        return origSetHdr.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        var meta = this.__bn_meta;
        if (meta && isHcap(meta.url)) {
          meta.bodyB64 = bytesToB64(body);
          meta.bodyLen = (body && (body.byteLength || body.length)) || 0;
          var self = this;
          this.addEventListener('load', function () {
            push({
              kind: 'xhr',
              method: meta.method,
              url: meta.url,
              reqHeaders: meta.headers,
              reqBodyB64: meta.bodyB64,
              reqBodyLen: meta.bodyLen,
              status: self.status,
              respB64: getRespBody(self),
              respType: self.responseType || 'text',
              respLen: (typeof self.response === 'string' ? self.response.length :
                        (self.response && self.response.byteLength) || 0),
              durMs: Date.now() - meta.t0,
            });
          }, false);
          this.addEventListener('error', function () {
            push({ kind: 'xhr-err', method: meta.method, url: meta.url });
          }, false);
        }
        return origSend.apply(this, arguments);
      };
    }

    // ─── fetch ───────────────────────────────────────────────────────
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        var url = (typeof input === 'string' || input instanceof URL)
          ? String(input) : (input && input.url) || '';
        var hcap = isHcap(url);
        var t0 = Date.now();
        var method = (init && init.method) || (input && input.method) || 'GET';
        var reqBodyB64 = null;
        if (hcap && init && init.body !== undefined && init.body !== null) {
          reqBodyB64 = bytesToB64(init.body);
        }
        var p = origFetch.apply(this, arguments);
        if (!hcap) return p;
        return p.then(function (resp) {
          // Clone so we don't consume the user's stream.
          try {
            var clone = resp.clone();
            return clone.arrayBuffer().then(function (buf) {
              push({
                kind: 'fetch',
                method: String(method),
                url: url,
                reqBodyB64: reqBodyB64,
                status: resp.status,
                respB64: bytesToB64(buf),
                respLen: buf.byteLength,
                durMs: Date.now() - t0,
              });
              return resp;
            }).catch(function () { return resp; });
          } catch (e) { return resp; }
        });
      };
    }

    // ─── <script src=...> tag loads (challenge JS comes via SRI script) ──
    var origCreate = document.createElement;
    document.createElement = function (tag) {
      var el = origCreate.apply(document, arguments);
      try {
        if (String(tag).toLowerCase() === 'script') {
          var origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
          if (origSrcDescriptor && origSrcDescriptor.set) {
            Object.defineProperty(el, 'src', {
              configurable: true,
              get: function () { return origSrcDescriptor.get.call(this); },
              set: function (v) {
                try {
                  if (isHcap(v)) {
                    push({ kind: 'script-src', url: String(v), integrity: el.integrity || null });
                  }
                } catch (e) {}
                return origSrcDescriptor.set.call(this, v);
              },
            });
          }
        }
      } catch (e) {}
      return el;
    };

  } catch (outer) {
    try { console.error('[bn-hcap-tap]', outer && outer.message); } catch(_){}
  }
})();`;

export async function attachHcapXhrTap(control: CdpScriptControl): Promise<InitScriptHandle> {
	return control.registerInitScript(HCAP_TAP_SCRIPT);
}

export async function detachHcapXhrTap(
	control: CdpScriptControl,
	handle: InitScriptHandle,
): Promise<void> {
	await control.unregisterInitScript(handle);
}

export interface HcapTapEntry {
	kind: 'xhr' | 'fetch' | 'xhr-err' | 'script-src';
	method?: string;
	url: string;
	status?: number;
	reqHeaders?: Record<string, string>;
	reqBodyB64?: string | null;
	reqBodyLen?: number;
	respB64?: string | null;
	respType?: string;
	respLen?: number;
	durMs?: number;
	integrity?: string | null;
}

/**
 * Drain the iframe(s) sink. Reads each frame's `__bn_hcap_xhr_data`
 * textContent and clears it. Buckets by frame URL.
 */
export async function drainHcapXhrTap(
	page: Page,
): Promise<{ frames: Record<string, HcapTapEntry[]> }> {
	const out: Record<string, HcapTapEntry[]> = {};
	for (const frame of page.frames()) {
		const url = frame.url();
		if (!url) continue;
		const text = (await frame
			.evaluate(`(() => {
				var s = document.getElementById('__bn_hcap_xhr_data');
				if (!s) return null;
				var t = s.textContent || '';
				s.textContent = '';
				return t;
			})()`)
			.catch(() => null)) as string | null;
		if (!text) continue;
		const entries: HcapTapEntry[] = [];
		for (const line of text.split('\n')) {
			if (!line) continue;
			try {
				entries.push(JSON.parse(line) as HcapTapEntry);
			} catch {
				/* ignore malformed line */
			}
		}
		if (entries.length > 0) out[url] = entries;
	}
	return { frames: out };
}
