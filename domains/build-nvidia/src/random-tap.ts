/**
 * E7-D — instrument `crypto.getRandomValues` in the live iframe.
 *
 * Counts every call hsw.js makes during a real mint, and records the
 * byte-size requested per call. Auto-propagates to OOPIFs (the hCaptcha
 * iframe). Runs as init script BEFORE hsw.js loads so we wrap the
 * native, un-overridden surface.
 *
 * Drains via DOM-channel `<script id="__bn_random_data">`.
 */
import type { CdpScriptControl, InitScriptHandle } from '@interceptor/browser/remote';
import type { Page } from 'patchright';

const TAP_SCRIPT = `(function() {
  if (window.__bn_rng_tap_installed) return;
  window.__bn_rng_tap_installed = true;

  var SINK = '__bn_random_data';
  function getSink() {
    var s = document.getElementById(SINK);
    if (!s) {
      s = document.createElement('script');
      s.id = SINK; s.type = 'application/json'; s.textContent = '';
      (document.documentElement || document.head || document.body).appendChild(s);
    }
    return s;
  }
  function push(o) {
    try {
      var s = getSink();
      s.textContent += JSON.stringify(o) + '\\n';
    } catch (e) {}
  }

  var origGetRandom = crypto.getRandomValues.bind(crypto);
  var counter = 0;
  crypto.getRandomValues = function(buf) {
    counter++;
    push({ kind: 'rng', n: counter, len: buf?.byteLength || buf?.length || 0, t: performance.now() });
    return origGetRandom(buf);
  };
  Object.defineProperty(window, '__bn_rng_count', { get: function() { return counter; }, configurable: true });

  // Also wrap crypto.subtle.* methods to count calls
  var subtleCounters = {};
  if (crypto.subtle) {
    var subtleMethods = ['encrypt','decrypt','sign','verify','digest','generateKey','deriveKey','deriveBits','importKey','exportKey','wrapKey','unwrapKey'];
    subtleMethods.forEach(function(m) {
      var orig = crypto.subtle[m];
      if (typeof orig !== 'function') return;
      subtleCounters[m] = 0;
      crypto.subtle[m] = function() {
        subtleCounters[m]++;
        push({ kind: 'subtle', method: m, n: subtleCounters[m], t: performance.now() });
        return orig.apply(crypto.subtle, arguments);
      };
    });
  }
  Object.defineProperty(window, '__bn_subtle_counts', { get: function() { return subtleCounters; }, configurable: true });

  // Also wrap hsw if it ever appears, so we can correlate with proof calls
  var capturedHsw = null;
  Object.defineProperty(window, 'hsw', {
    configurable: true, enumerable: true,
    get: function() { return capturedHsw; },
    set: function(v) {
      if (typeof v !== 'function') { capturedHsw = v; return; }
      capturedHsw = function() {
        var args = Array.prototype.slice.call(arguments);
        var preCount = counter;
        var t0 = performance.now();
        var res = v.apply(this, args);
        if (res && typeof res.then === 'function') {
          return res.then(function(out) {
            push({ kind: 'hsw-call', preCount: preCount, postCount: counter, deltaCount: counter - preCount,
                   durMs: performance.now() - t0,
                   inMode: typeof args[0],
                   inLen: args.length === 1 && typeof args[0] === 'string' ? args[0].length :
                          (args[1]?.byteLength || args[1]?.length || 0),
                   outType: out && out.constructor ? out.constructor.name : typeof out,
                   outLen: typeof out === 'string' ? out.length : (out?.byteLength || out?.length || 0) });
            return out;
          });
        } else {
          push({ kind: 'hsw-call-sync', preCount: preCount, postCount: counter, deltaCount: counter - preCount,
                 durMs: performance.now() - t0,
                 inMode: typeof args[0],
                 outType: res && res.constructor ? res.constructor.name : typeof res,
                 outLen: typeof res === 'string' ? res.length : (res?.byteLength || res?.length || 0) });
          return res;
        }
      };
    },
  });
})();`;

export async function attachRandomTap(control: CdpScriptControl): Promise<InitScriptHandle> {
	return control.registerInitScript(TAP_SCRIPT);
}

export async function detachRandomTap(
	control: CdpScriptControl,
	handle: InitScriptHandle,
): Promise<void> {
	await control.unregisterInitScript(handle);
}

export interface RandomTapEntry {
	kind: 'rng' | 'hsw-call' | 'hsw-call-sync';
	n?: number;
	len?: number;
	t?: number;
	preCount?: number;
	postCount?: number;
	deltaCount?: number;
	durMs?: number;
	inMode?: string;
	inLen?: number;
	outType?: string;
	outLen?: number;
}

export async function drainRandomTap(
	page: Page,
): Promise<{ frames: Record<string, RandomTapEntry[]> }> {
	const out: Record<string, RandomTapEntry[]> = {};
	for (const frame of page.frames()) {
		const url = frame.url();
		if (!url) continue;
		const text = (await frame
			.evaluate(`(() => {
				var s = document.getElementById('__bn_random_data');
				if (!s) return null;
				var t = s.textContent || '';
				s.textContent = '';
				return t;
			})()`)
			.catch(() => null)) as string | null;
		if (!text) continue;
		const entries: RandomTapEntry[] = [];
		for (const line of text.split('\n')) {
			if (!line) continue;
			try { entries.push(JSON.parse(line) as RandomTapEntry); } catch { /* skip */ }
		}
		if (entries.length > 0) out[url] = entries;
	}
	return { frames: out };
}
