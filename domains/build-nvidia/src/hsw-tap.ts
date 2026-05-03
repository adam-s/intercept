/**
 * E7 — capture exact inputs/outputs of `window.hsw` in the live iframe.
 *
 * We have the proof JS running in Node (E7-A/B done). What we don't know
 * is the SHAPE of the msgpack payload that the bundle's `Mr` function
 * passes to `hsw(1, …)`. Instead of guessing fields, intercept the live
 * call and dump everything to the cross-world DOM channel.
 *
 * Strategy: install an init script in the iframe that defines `window.hsw`
 * as an accessor — when the proof JS later assigns `window.hsw = X`, the
 * setter wraps X with a logger that records (mode, input bytes, output
 * bytes). The wrapper is itself reachable as `window.hsw` so the bundle
 * uses our wrapper transparently.
 */

import type { CdpScriptControl, InitScriptHandle } from '@interceptor/browser/remote';
import type { Page } from 'patchright';

const HSW_TAP_SCRIPT = `(function() {
  if (window.__bn_hsw_tap_installed) return;
  window.__bn_hsw_tap_installed = true;

  var SINK_ID = '__bn_hsw_data';
  var MAX = 16 * 1024 * 1024;

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
  function bytesToB64(buf) {
    try {
      if (typeof buf === 'string') return btoa(unescape(encodeURIComponent(buf)));
      if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
      if (buf instanceof Uint8Array) {
        var s = '';
        for (var i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
        return btoa(s);
      }
    } catch (e) {}
    return null;
  }
  function push(entry) {
    try {
      var s = getSink();
      var line = JSON.stringify(entry);
      if (s.textContent.length + line.length + 1 > MAX) return;
      s.textContent = s.textContent + line + '\\n';
    } catch (e) {}
  }

  var captured = null;
  Object.defineProperty(window, 'hsw', {
    configurable: true,
    enumerable: true,
    get: function () { return captured; },
    set: function (v) {
      if (typeof v !== 'function') { captured = v; return; }
      // Wrap the proof function to log calls.
      captured = function () {
        var args = Array.prototype.slice.call(arguments);
        var t0 = Date.now();
        var inSummary;
        // Reclassify based on args.
        //   bootstrap: hsw("<JWT or 'IiI=...' string>")  — single string arg
        //   proof:     hsw(jwtString, optsObject)        — string + object
        //   encrypt:   hsw(1, msgpackBytes)              — number + bytes
        //   decrypt:   hsw(0, encryptedBytes)            — number + bytes
        if (typeof args[0] === 'string') {
          // bootstrap or proof — distinguish by presence of opts arg
          inSummary = {
            mode: args.length === 1 ? 'bootstrap' : 'proof',
            jwt: args[0],
            jwtLen: args[0].length,
          };
          if (args.length >= 2) {
            // opts is { href, ardata, vm_data, uj_data, errors?, messages? }
            try {
              inSummary.opts = JSON.stringify(args[1]);
              inSummary.optsLen = inSummary.opts.length;
            } catch (e) {
              inSummary.optsErr = String(e.message || e);
            }
          }
        } else if (typeof args[0] === 'number' && args.length >= 2) {
          var input = args[1];
          inSummary = {
            mode: args[0],
            inputType: input && input.constructor ? input.constructor.name : typeof input,
            inputLen: input && (input.byteLength || input.length) || 0,
            inputB64: bytesToB64(input),
          };
        } else {
          inSummary = { argv: 'unrecognised', argc: args.length };
        }
        var ret;
        try { ret = v.apply(this, args); }
        catch (e) {
          push({ kind: 'hsw-throw', t: t0, in: inSummary, err: String(e && e.message || e) });
          throw e;
        }
        if (ret && typeof ret.then === 'function') {
          return ret.then(function (out) {
            var outSummary = { type: out && out.constructor ? out.constructor.name : typeof out };
            if (out instanceof Uint8Array || out instanceof ArrayBuffer) {
              outSummary.byteLength = out.byteLength || out.length;
              outSummary.outB64 = bytesToB64(out);
            } else if (typeof out === 'string') {
              outSummary.length = out.length;
              outSummary.preview = out.slice(0, 80);
            }
            push({ kind: 'hsw-call', t: t0, durMs: Date.now() - t0, in: inSummary, out: outSummary });
            return out;
          }, function (err) {
            push({ kind: 'hsw-reject', t: t0, in: inSummary, err: String(err && err.message || err) });
            throw err;
          });
        } else {
          var outSummary = { type: ret && ret.constructor ? ret.constructor.name : typeof ret };
          if (ret instanceof Uint8Array || ret instanceof ArrayBuffer) {
            outSummary.byteLength = ret.byteLength || ret.length;
            outSummary.outB64 = bytesToB64(ret);
          } else if (typeof ret === 'string') {
            outSummary.length = ret.length;
            outSummary.preview = ret.slice(0, 80);
          }
          push({ kind: 'hsw-call', t: t0, durMs: Date.now() - t0, in: inSummary, out: outSummary });
          return ret;
        }
      };
    },
  });
})();`;

export async function attachHswTap(control: CdpScriptControl): Promise<InitScriptHandle> {
	return control.registerInitScript(HSW_TAP_SCRIPT);
}

export async function detachHswTap(
	control: CdpScriptControl,
	handle: InitScriptHandle,
): Promise<void> {
	await control.unregisterInitScript(handle);
}

export interface HswCallEntry {
	kind: 'hsw-call' | 'hsw-throw' | 'hsw-reject';
	t: number;
	durMs?: number;
	in: Record<string, unknown>;
	out?: Record<string, unknown>;
	err?: string;
}

export async function drainHswTap(page: Page): Promise<{ frames: Record<string, HswCallEntry[]> }> {
	const out: Record<string, HswCallEntry[]> = {};
	for (const frame of page.frames()) {
		const url = frame.url();
		if (!url) continue;
		const text = (await frame
			.evaluate(`(() => {
				var s = document.getElementById('__bn_hsw_data');
				if (!s) return null;
				var t = s.textContent || '';
				s.textContent = '';
				return t;
			})()`)
			.catch(() => null)) as string | null;
		if (!text) continue;
		const entries: HswCallEntry[] = [];
		for (const line of text.split('\n')) {
			if (!line) continue;
			try {
				entries.push(JSON.parse(line) as HswCallEntry);
			} catch {
				/* skip */
			}
		}
		if (entries.length > 0) out[url] = entries;
	}
	return { frames: out };
}
