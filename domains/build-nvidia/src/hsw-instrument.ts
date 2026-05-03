/**
 * E7-D — INTERCEPT + INSTRUMENT hsw.js to find the fast/slow code path
 * branch that diverges between Chrome and Node.
 *
 * Approach:
 *   1. Init script: bypass SRI by overriding HTMLScriptElement.prototype.integrity
 *      setter (and Element.prototype.setAttribute for "integrity") to no-op.
 *      This must run BEFORE inline.js's Wr() creates the proof-script tag.
 *   2. Init script: define `window.__bn_hi(N)` to push a function-id into
 *      a hidden DOM-channel sink.
 *   3. CdpScriptControl.decorateScript: intercept the hsw.js URL pattern,
 *      replace bytes with an INSTRUMENTED version that injects `__bn_hi(N);`
 *      at the start of every function body.
 *   4. Drive a mint. Drain the sink. We now have the exact function call
 *      sequence Chrome's hsw.js executed.
 *   5. Run the SAME instrumented hsw.js in Node. Compare call sequences.
 *      The first divergence is the fast/slow branch.
 *
 * Property: the SRI bypass + byte mutation only works in our Node-side
 * Patchright instance (CdpScriptControl owns the Fetch interception). The
 * iframe's CSP `script-src 'self' 'unsafe-eval'` permits same-origin
 * scripts regardless of content (CSP doesn't fingerprint content), so
 * mutating bytes doesn't trip CSP. SRI IS content-checked, hence the
 * setter override.
 */

import type { CdpScriptControl, InitScriptHandle } from '@interceptor/browser/remote';
import type { Page } from 'patchright';

// ─── source-level instrumenter ─────────────────────────────────────────

/**
 * Inject `;__bn_hi(N);` at the start of every function body in the source.
 * Returns the patched source + the total counter used (for sanity check).
 *
 * Matches `function name?(args){` patterns. Misses arrow functions but
 * covers the heavy minified/obfuscated form used in hsw.js.
 */
export function instrumentHswSource(src: string): { patched: string; counter: number } {
	let counter = 0;
	const patched = src.replace(/function\s*(?:[\w$]+)?\s*\(([^)]*)\)\s*\{/g, (match) => {
		counter++;
		// Inject our log call right after the opening brace
		return `${match}window.__bn_hi&&window.__bn_hi(${counter});`;
	});
	return { patched, counter };
}

// ─── init script: SRI bypass + sink + counter ──────────────────────────

const INSTRUMENT_INIT_SCRIPT = `(function() {
  if (window.__bn_hi_installed) return;
  window.__bn_hi_installed = true;

  // ─── SRI bypass ──────────────────────────────────────────────────
  try {
    var integrityDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'integrity');
    if (integrityDesc && integrityDesc.set) {
      Object.defineProperty(HTMLScriptElement.prototype, 'integrity', {
        configurable: true, enumerable: true,
        get: integrityDesc.get,
        set: function() { /* no-op — SRI bypassed */ },
      });
    }
  } catch (e) {}

  // Also strip integrity passed via setAttribute
  try {
    var origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (this.tagName === 'SCRIPT' && String(name).toLowerCase() === 'integrity') return;
      return origSetAttr.call(this, name, value);
    };
  } catch (e) {}

  // ─── per-function counter ────────────────────────────────────────
  var counts = {};
  var sequence = []; // optional: ordered call trace
  window.__bn_hi = function(n) {
    counts[n] = (counts[n] || 0) + 1;
    if (sequence.length < 50000) sequence.push(n);
  };
  window.__bn_hi_dump = function() { return { counts: counts, sequence: sequence }; };
  window.__bn_hi_reset = function() { counts = {}; sequence = []; };

  // Cross-world readable mirror via DOM-channel
  var SINK = '__bn_hi_data';
  function getSink() {
    var s = document.getElementById(SINK);
    if (!s) {
      s = document.createElement('script');
      s.id = SINK; s.type = 'application/json'; s.textContent = '';
      (document.documentElement || document.head || document.body).appendChild(s);
    }
    return s;
  }
  // Periodically flush counts to sink so we can drain from isolated world
  var lastFlush = 0;
  var flushTimer = setInterval(function() {
    try {
      if (lastFlush === sequence.length) return;
      var s = getSink();
      s.textContent = JSON.stringify({ counts: counts, sequenceLen: sequence.length, ts: Date.now() });
      lastFlush = sequence.length;
    } catch (e) {}
  }, 500);
})();`;

// ─── public API ────────────────────────────────────────────────────────

export interface HswInstrumentHandle {
	initScript: InitScriptHandle;
	decoratorStop: () => Promise<void>;
	totalFunctions: number;
}

/**
 * Attach the SRI-bypass init script + a decorator that replaces hsw.js
 * with the instrumented version on the fly.
 */
export async function attachHswInstrument(control: CdpScriptControl): Promise<HswInstrumentHandle> {
	const initScript = await control.registerInitScript(INSTRUMENT_INIT_SCRIPT);

	let totalFunctions = 0;
	const decoratorStop = await control.decorateScript(
		{ urlPattern: '*newassets.hcaptcha.com*hsw.js*', resourceType: 'Script' },
		(captured) => {
			const { patched, counter } = instrumentHswSource(captured.body);
			totalFunctions = counter;
			return patched;
		},
	);

	return { initScript, decoratorStop, totalFunctions };
}

export async function detachHswInstrument(
	control: CdpScriptControl,
	handle: HswInstrumentHandle,
): Promise<void> {
	await handle.decoratorStop();
	await control.unregisterInitScript(handle.initScript);
}

export interface HswInstrumentDump {
	counts: Record<string, number>;
	sequenceLen: number;
	ts: number;
}

export async function drainHswInstrument(
	page: Page,
): Promise<{ frames: Record<string, HswInstrumentDump | null> }> {
	const out: Record<string, HswInstrumentDump | null> = {};
	for (const frame of page.frames()) {
		const url = frame.url();
		if (!url) continue;
		const text = (await frame
			.evaluate(`(() => {
				var s = document.getElementById('__bn_hi_data');
				return s ? s.textContent : null;
			})()`)
			.catch(() => null)) as string | null;
		if (text === null) continue;
		try {
			out[url] = JSON.parse(text) as HswInstrumentDump;
		} catch {
			out[url] = null;
		}
	}
	return { frames: out };
}
