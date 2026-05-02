/**
 * Build-nvidia debug instrumentation — Phase 2c follow-up.
 *
 * Wraps the `execute(t)` method in the @hcaptcha/react-hcaptcha module
 * (NVIDIA's React bundle) so we can log every call NVIDIA's UI makes to
 * the captcha SDK along with its arguments. Combined with the existing
 * postMessage capture (captcha-frame.ts), this gives a full view of the
 * token round-trip without touching anything hCaptcha protects.
 *
 * APPROACH
 *   1. Install an init script that defines `window.__bn_instr(name, args)`
 *      — pushes log entries onto a ring buffer. Runs in main world before
 *      any page script.
 *   2. Use `CdpScriptControl.decorateScript` to mutate NVIDIA's react-
 *      hcaptcha chunk in flight: prepend a logging call to the start of
 *      `execute(t)`. The chunk is standard Next.js, no self-checksum.
 *   3. Expose a polling helper to drain the buffer.
 *
 * SAFETY NOTES
 *   - We do NOT mutate any hCaptcha-served bundle (those have CSP +
 *     ECDSA self-checksum). Only NVIDIA's Next.js chunks.
 *   - Wrapper preserves the original function body unchanged — we only
 *     prepend an instrumentation call. Worst case: extra entries in the
 *     log buffer, no behavioural change.
 *   - The bundle URL hash rotates on NVIDIA deploys. The mutator's regex
 *     keys on the function signature, not the URL hash, so it survives.
 */

import type { CdpScriptControl, InitScriptHandle } from '@interceptor/browser/remote';

/** Pattern: matches the `execute(t)` method on react-hcaptcha's prototype.
 *  Generic over the single-letter minified prefix (any letter / `$`). */
const EXECUTE_PATTERN =
	/([A-Za-z_$])\.execute=function\(([A-Za-z_$])\)\{var ([A-Za-z_$])=this;void 0===\2&&\(\2=null\),\2="object"==typeof \2\?\2:null;/;

/**
 * Init script — hooks window.fetch + XMLHttpRequest, captures every request
 * to api.ngc.nvidia.com or api.hcaptcha.com along with method/url/headers/
 * body/duration/status. Runs in MAIN world before any page script.
 *
 * Bonus: hooks postMessage on every iframe so we see the parent → iframe
 * direction (the iframe → parent direction was already captured via
 * the existing /pm/start route on the parent's message listener).
 */
const BN_INSTR_INIT = `(function () {
  try {
    // No idempotency guard: across server restarts, an older copy of this
    // init script may still be registered on the browser process. We always
    // reinstall so the active fetch/XHR hooks reflect the LATEST version.
    document.documentElement.setAttribute('data-bn-instr', 'enter');
    var buf = window.__bn_log && Array.isArray(window.__bn_log) ? window.__bn_log : [];
    window.__bn_log = buf;
    window.__bn_instr = function (name, payload) {
      try {
        var pv;
        try { pv = JSON.parse(JSON.stringify(payload)); }
        catch (e) { pv = String(payload); }
        buf.push({ name: String(name), payload: pv, ts: Date.now() });
        if (buf.length > 500) buf.shift();
      } catch (e) { /* never throw */ }
    };
    document.documentElement.setAttribute('data-bn-instr', 'instr-set');

    var INTEREST = /api\\.ngc\\.nvidia\\.com|api\\.hcaptcha\\.com|hcaptcha\\.com/;
    document.documentElement.setAttribute('data-bn-instr', 'regex-ok');

    // ── window.fetch ────────────────────────────────────────────────
    var origFetch = window.fetch;
    document.documentElement.setAttribute('data-bn-instr', 'fetch-saved');
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (INTEREST.test(url)) {
          var hdrs = {};
          var src = (init && init.headers) || (input && input.headers) || null;
          if (src && typeof src.forEach === 'function') {
            src.forEach(function (v, k) { hdrs[k] = v; });
          } else if (src && typeof src === 'object') {
            Object.keys(src).forEach(function (k) { hdrs[k] = src[k]; });
          }
          var bodyPreview = null;
          var b = init && init.body;
          if (typeof b === 'string') bodyPreview = b.slice(0, 800);
          else if (b && b.toString) bodyPreview = '[' + (b.constructor && b.constructor.name) + ']';
          window.__bn_instr('fetch.req', {
            url: url, method: (init && init.method) || (input && input.method) || 'GET',
            headers: hdrs, bodyPreview: bodyPreview,
          });
          var t0 = performance.now();
          var p = origFetch.apply(this, arguments);
          p.then(function (r) {
            try {
              var rh = {};
              r.headers && r.headers.forEach && r.headers.forEach(function (v, k) { rh[k] = v; });
              window.__bn_instr('fetch.res', {
                url: url, status: r.status, dur: Math.round(performance.now() - t0), headers: rh,
              });
            } catch (e) {}
          }, function (e) {
            window.__bn_instr('fetch.err', { url: url, error: String(e && e.message || e) });
          });
          return p;
        }
      } catch (e) { /* never throw out of fetch wrapper */ }
      return origFetch.apply(this, arguments);
    };
    document.documentElement.setAttribute('data-bn-instr', 'fetch-hooked');

    // ── XMLHttpRequest ──────────────────────────────────────────────
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      var origSetHdr = XHR.prototype.setRequestHeader;
      XHR.prototype.open = function (m, u) {
        try {
          if (INTEREST.test(u || '')) {
            this.__bn = { url: u, method: m, headers: {}, t0: 0 };
          }
        } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.setRequestHeader = function (k, v) {
        try { if (this.__bn) this.__bn.headers[k] = v; } catch (e) {}
        return origSetHdr.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        try {
          if (this.__bn) {
            this.__bn.t0 = performance.now();
            var bp = null;
            if (typeof body === 'string') bp = body.slice(0, 800);
            window.__bn_instr('xhr.req', {
              url: this.__bn.url, method: this.__bn.method,
              headers: this.__bn.headers, bodyPreview: bp,
            });
            var self = this;
            this.addEventListener('loadend', function () {
              try {
                window.__bn_instr('xhr.res', {
                  url: self.__bn.url, status: self.status,
                  dur: Math.round(performance.now() - self.__bn.t0),
                });
              } catch (e) {}
            });
          }
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
    }

    document.documentElement.setAttribute('data-bn-instr', 'xhr-hooked');

    // ── window.postMessage from parent → log outgoing messages ──────
    // (incoming ones the parent already captures via captureHCaptchaPostMessages)
    var origPM = window.postMessage;
    // postMessage is on the Window itself; wrapping is tricky cross-context.
    // Instead, hook contentWindow.postMessage on iframes as they appear.
    function hookIframe(ifr) {
      try {
        if (ifr.__bn_pm_hooked) return;
        if (!INTEREST.test(ifr.src || '')) return;
        var cw = ifr.contentWindow;
        if (!cw) return;
        var orig = cw.postMessage;
        cw.postMessage = function (msg, target, transfer) {
          try {
            window.__bn_instr('iframe.postMessage', {
              src: ifr.src, msg: typeof msg === 'object' ? JSON.parse(JSON.stringify(msg)) : String(msg),
              target: target,
            });
          } catch (e) {}
          return orig.call(this, msg, target, transfer);
        };
        ifr.__bn_pm_hooked = true;
      } catch (e) { /* cross-origin throw is normal */ }
    }
    function scanIframes() {
      var fs = document.querySelectorAll('iframe');
      for (var i = 0; i < fs.length; i++) hookIframe(fs[i]);
    }
    if (document.readyState !== 'loading') {
      scanIframes();
    } else {
      document.addEventListener('DOMContentLoaded', scanIframes);
    }
    setInterval(scanIframes, 1000);
    document.documentElement.setAttribute('data-bn-instr', 'all-done');

  } catch (e) {
    try { document.documentElement.setAttribute('data-bn-err', String(e && e.message || e).slice(0, 200)); } catch (_) {}
  }
})();`;

export interface InstrumentLogEntry {
	name: string;
	args: unknown;
	ts: number;
}

export interface MutationRecord {
	url: string;
	before: number;
	after: number;
	reason?: string;
	ts: number;
}

export class BuildNvidiaInstrument {
	private control: CdpScriptControl | null = null;
	private initHandle: InitScriptHandle | null = null;
	private decorateStop: (() => Promise<void>) | null = null;
	readonly mutations: MutationRecord[] = [];

	get attached(): boolean {
		return this.initHandle !== null;
	}

	async attach(control: CdpScriptControl): Promise<void> {
		if (this.attached) return;
		this.control = control;

		// MINIMAL DIAG init script — sets a marker so we can confirm at all
		// that addInitScript is reaching the page on this profile.
		const diag = `try { document.documentElement.setAttribute('data-bn-diag', 'ran-' + Date.now()); } catch (e) {}`;
		await control.registerInitScript(diag).catch(() => {});

		this.initHandle = await control.registerInitScript(BN_INSTR_INIT);

		this.decorateStop = await control.decorateScript(
			{ urlPattern: '*build.nvidia.com/_next/static/chunks/*' },
			(cap) => {
				const before = cap.body.length;
				const m = EXECUTE_PATTERN.exec(cap.body);
				if (!m) return null; // not the chunk that has react-hcaptcha; pass through
				// Insert instrumentation call as the FIRST statement inside the function body.
				// Only wrap if the prefix and arg names line up with the captured groups —
				// the regex already enforced that, but spell it out for the replacement.
				const replacement = `${m[1]}.execute=function(${m[2]}){window.__bn_instr&&window.__bn_instr('rhc.execute',[${m[2]}]);var ${m[3]}=this;void 0===${m[2]}&&(${m[2]}=null),${m[2]}="object"==typeof ${m[2]}?${m[2]}:null;`;
				const next = cap.body.replace(EXECUTE_PATTERN, replacement);
				if (next === cap.body) {
					this.mutations.push({
						url: cap.url,
						before,
						after: before,
						reason: 'replace produced identical body',
						ts: Date.now(),
					});
					return null;
				}
				this.mutations.push({ url: cap.url, before, after: next.length, ts: Date.now() });
				return next;
			},
		);
	}

	/**
	 * Drain the in-page log buffer (`window.__bn_log`). Returns the
	 * captured entries since the last drain and clears the buffer in-page.
	 * Reads from MAIN world (where the buffer lives) — Patchright's
	 * isolated-world `page.evaluate` cannot see it.
	 */
	async drain(): Promise<InstrumentLogEntry[]> {
		if (!this.control) return [];
		const entries =
			(await this.control.evaluateInMainWorld<InstrumentLogEntry[]>(
				`(() => { const b = window.__bn_log; if (!b) return []; const out = b.slice(); b.length = 0; return out; })()`,
			)) ?? [];
		return entries;
	}

	async detach(): Promise<void> {
		if (this.decorateStop) {
			await this.decorateStop().catch(() => {});
			this.decorateStop = null;
		}
		if (this.control && this.initHandle) {
			await this.control.unregisterInitScript(this.initHandle).catch(() => {});
			this.initHandle = null;
		}
		this.control = null;
	}
}
