/**
 * E7-D — capture WASM imports during a real Chrome iframe mint, so we
 * can replay the same return values in our Node WASM bridge.
 *
 * hsw.js loads a 530KB WebAssembly module and dispatches all crypto work
 * to its exports (ec / encrypt_req_data / decrypt_resp_data). The WASM
 * module imports 22 JS callback functions (named e, la, ua, ia, Mb, …)
 * for environment access. Output size differs between Chrome and our
 * Node + happy-dom env because the JS callbacks return different values.
 *
 * This init script:
 *   1. Wraps `WebAssembly.instantiate` BEFORE hsw.js loads.
 *   2. When called: wraps each import function in the imports object
 *      to log every (ns, fn, call#, args, result) to the DOM-channel sink.
 *   3. Wraps each EXPORT to log entry/exit for ec/encrypt/decrypt.
 *   4. Also captures the WASM memory snapshot after each mint cycle
 *      so we can compare in/out memory state.
 *
 * Captured data → replayed in Node-side test harness. Same WASM module +
 * same import returns + same memory state → same output (deterministic).
 */
import type { CdpScriptControl, InitScriptHandle } from '@interceptor/browser/remote';
import type { Page } from 'patchright';

const TAP_SCRIPT = `(function() {
  if (window.__bn_wi_tap_installed) return;
  window.__bn_wi_tap_installed = true;

  var SINK = '__bn_wi_data';
  function getSink() {
    var s = document.getElementById(SINK);
    if (!s) {
      s = document.createElement('script');
      s.id = SINK; s.type = 'application/json'; s.textContent = '';
      (document.documentElement || document.head || document.body).appendChild(s);
    }
    return s;
  }
  var bufferedLines = [];
  var totalBytes = 0;
  var MAX_BYTES = 16 * 1024 * 1024;
  function push(line) {
    var s = JSON.stringify(line);
    if (totalBytes + s.length + 1 > MAX_BYTES) return;
    bufferedLines.push(s);
    totalBytes += s.length + 1;
  }
  // Flush periodically
  setInterval(function() {
    try {
      if (bufferedLines.length === 0) return;
      var s = getSink();
      s.textContent = s.textContent + bufferedLines.join('\\n') + '\\n';
      bufferedLines = [];
    } catch (e) {}
  }, 250);

  var moduleCounter = 0;
  var origInstantiate = WebAssembly.instantiate;

  WebAssembly.instantiate = function(buffer, importObject) {
    var modId = ++moduleCounter;
    var bufLen = buffer && (buffer.byteLength || buffer.length) || 0;
    push({ kind: 'instantiate', modId: modId, bufLen: bufLen, importNs: importObject ? Object.keys(importObject) : [] });

    // Wrap each import function
    var wrappedImports = {};
    var importCallCounts = {};
    for (var ns in importObject) {
      wrappedImports[ns] = {};
      for (var fn in importObject[ns]) {
        var orig = importObject[ns][fn];
        if (typeof orig === 'function') {
          (function(ns, fn, orig) {
            importCallCounts[ns + '.' + fn] = 0;
            wrappedImports[ns][fn] = function() {
              var key = ns + '.' + fn;
              var callN = ++importCallCounts[key];
              var args = Array.prototype.slice.call(arguments);
              var result;
              var threw = false;
              var errMsg = null;
              try {
                result = orig.apply(this, args);
              } catch (e) {
                threw = true; errMsg = String(e && e.message || e);
                push({ kind: 'import-throw', modId: modId, ns: ns, fn: fn, n: callN, args: args, err: errMsg });
                throw e;
              }
              // Result might be a number (WASM ABI), or a Promise, or void
              var resultSummary;
              if (result === undefined) resultSummary = { type: 'undefined' };
              else if (typeof result === 'number') resultSummary = { type: 'number', val: result };
              else if (typeof result === 'string') resultSummary = { type: 'string', val: result.slice(0, 200), len: result.length };
              else if (result === null) resultSummary = { type: 'null' };
              else if (typeof result === 'object' && typeof result.then === 'function') resultSummary = { type: 'promise' };
              else resultSummary = { type: typeof result, ctor: result?.constructor?.name };
              push({ kind: 'import-call', modId: modId, ns: ns, fn: fn, n: callN, args: args, result: resultSummary });
              return result;
            };
          })(ns, fn, orig);
        } else {
          wrappedImports[ns][fn] = orig;
        }
      }
    }

    // Capture buffer first 256 bytes for fingerprinting
    try {
      var bufView = new Uint8Array(buffer);
      var head = '';
      for (var i = 0; i < Math.min(64, bufView.length); i++) head += bufView[i].toString(16).padStart(2,'0');
      push({ kind: 'instantiate-buf', modId: modId, head: head, totalLen: bufLen });
    } catch (e) {}

    return origInstantiate(buffer, wrappedImports).then(function(result) {
      push({ kind: 'instantiate-done', modId: modId, exports: result.instance ? Object.keys(result.instance.exports).slice(0, 60) : [] });

      // Wrap exports too — for ec / encrypt_req_data / decrypt_resp_data
      var origExports = result.instance.exports;
      var wrappedExports = {};
      var exportCallCounts = {};
      for (var k in origExports) {
        var v = origExports[k];
        if (typeof v === 'function' && (k === 'ec' || k === 'encrypt_req_data' || k === 'decrypt_resp_data')) {
          (function(name, vfn) {
            exportCallCounts[name] = 0;
            wrappedExports[name] = function() {
              var args = Array.prototype.slice.call(arguments);
              var callN = ++exportCallCounts[name];
              push({ kind: 'export-enter', modId: modId, fn: name, n: callN, args: args });
              var r;
              try { r = vfn.apply(this, args); }
              catch (e) {
                push({ kind: 'export-throw', modId: modId, fn: name, n: callN, err: String(e?.message || e) });
                throw e;
              }
              push({ kind: 'export-exit', modId: modId, fn: name, n: callN, result: r });
              return r;
            };
          })(k, v);
        } else {
          wrappedExports[k] = v;
        }
      }
      return { instance: { exports: wrappedExports }, module: result.module };
    });
  };
})();`;

export async function attachWasmImportTap(control: CdpScriptControl): Promise<InitScriptHandle> {
	return control.registerInitScript(TAP_SCRIPT);
}

export async function detachWasmImportTap(
	control: CdpScriptControl,
	handle: InitScriptHandle,
): Promise<void> {
	await control.unregisterInitScript(handle);
}

export interface WasmImportEntry {
	kind: 'instantiate' | 'instantiate-buf' | 'instantiate-done' | 'import-call' | 'import-throw' | 'export-enter' | 'export-exit' | 'export-throw';
	modId?: number;
	ns?: string;
	fn?: string;
	n?: number;
	args?: unknown[];
	result?: unknown;
	err?: string;
	bufLen?: number;
	head?: string;
	exports?: string[];
	importNs?: string[];
	totalLen?: number;
}

export async function drainWasmImportTap(
	page: Page,
): Promise<{ frames: Record<string, WasmImportEntry[]> }> {
	const out: Record<string, WasmImportEntry[]> = {};
	for (const frame of page.frames()) {
		const url = frame.url();
		if (!url) continue;
		const text = (await frame
			.evaluate(`(() => {
				var s = document.getElementById('__bn_wi_data');
				if (!s) return null;
				var t = s.textContent || '';
				s.textContent = '';
				return t;
			})()`)
			.catch(() => null)) as string | null;
		if (!text) continue;
		const entries: WasmImportEntry[] = [];
		for (const line of text.split('\n')) {
			if (!line) continue;
			try { entries.push(JSON.parse(line) as WasmImportEntry); } catch { /* skip */ }
		}
		if (entries.length > 0) out[url] = entries;
	}
	return { frames: out };
}
