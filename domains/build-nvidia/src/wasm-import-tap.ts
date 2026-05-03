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

  // Full-mint bridge: drive checksiteconfig + hsw + getcaptcha entirely
  // inside the iframe (where window.hsw exists in main world). Returns the
  // server's response status + body so we can isolate where things break.
  document.addEventListener('__bn_full_mint', function(ev) {
    var detail = ev && ev.detail;
    if (!detail) return;
    var id = detail.id;
    var sitekey = detail.sitekey;
    var host = detail.host;
    var version = detail.version;
    var href = detail.href;
    var reply = function(d) {
      try { document.dispatchEvent(new CustomEvent('__bn_full_mint_resp', { detail: Object.assign({ id: id }, d) })); }
      catch (e) {}
    };
    (async function() {
      if (typeof window.hsw !== 'function') { reply({ ok: false, error: 'no hsw' }); return; }
      try {
        var t0 = Date.now();
        var r1 = await fetch('https://api.hcaptcha.com/checksiteconfig?v=' + version + '&host=' + host + '&sitekey=' + sitekey + '&sc=1&swa=1&spst=1', {
          method: 'POST', credentials: 'include',
          headers: { 'accept': 'application/json', 'content-type': 'text/plain' },
        });
        var j = await r1.json();
        if (!j || !j.c || !j.c.req) { reply({ ok: false, error: 'no spec.req', resp: j }); return; }
        var spec = j.c;
        var proof = await window.hsw(spec.req, { href: href, ardata: null, vm_data: null, uj_data: null, errors: [] });
        var payload = {
          v: version, sitekey: sitekey, host: host, hl: 'en',
          motionData: JSON.stringify({
            st: Date.now() - 5000,
            mm: [[100,200,100],[110,210,200],[120,220,300]], mm_mp: 0.5,
            md: [[100,200,50]], md_mp: 0.4, mu: [[120,220,350]], mu_mp: 0.3, v: 1,
            topLevel: { st: Date.now() - 6000, sc: { availWidth: 1024, availHeight: 576 } },
            session: [], widgetList: ['e7w'], widgetId: 'e7w',
            href: href,
            prev: { escaped: false, passed: false, expiredChallenge: false, expiredResponse: false },
          }),
          pdc: '{}', pem: JSON.stringify({ csc: 100, csch: 'api.hcaptcha.com', cscrt: 0, cscft: 100 }),
          n: proof, e: null,
        };
        // We can't easily msgpack-encode the body in the iframe without a lib.
        // Instead we dispatch a step-by-step return so the caller can finish
        // assembly in Node and send back via __bn_post_getcaptcha if needed.
        reply({
          ok: true, durationMs: Date.now() - t0,
          specJson: JSON.stringify(spec),
          proof: typeof proof === 'string' ? proof : null, proofLen: typeof proof === 'string' ? proof.length : -1,
          payload: payload,
        });
      } catch (e) { reply({ ok: false, error: String(e && e.message || e) }); }
    })();
  }, false);

  // Iframe-side encrypt-only: hsw(1, packedPayload), return enc bytes.
  // Lets caller (Node) build body + POST to isolate encryption from submission.
  document.addEventListener('__bn_iframe_encrypt', function(ev) {
    var detail = ev && ev.detail;
    if (!detail) return;
    var id = detail.id;
    var packed = detail.packedPayload;
    var reply = function(d) {
      try { document.dispatchEvent(new CustomEvent('__bn_iframe_encrypt_resp', { detail: Object.assign({ id: id }, d) })); }
      catch (e) {}
    };
    (async function() {
      if (typeof window.hsw !== 'function') { reply({ ok: false, error: 'no hsw' }); return; }
      try {
        var enc = await window.hsw(1, packed);
        var u8 = enc instanceof Uint8Array ? enc : new Uint8Array(enc);
        reply({ ok: true, encB64: btoa(String.fromCharCode.apply(null, u8.slice(0, Math.min(u8.length, 200000)))), encLen: u8.length });
      } catch (e) { reply({ ok: false, error: String(e && e.message || e) }); }
    })();
  }, false);

  // Iframe-side msgpack+POST: take a payload from the caller, encrypt via
  // hsw(1, msgpack(payload)), POST to /getcaptcha, return server response.
  // (We use msgpack-via-array-of-bytes that the caller pre-builds; the
  // iframe just does the encrypt + send.)
  document.addEventListener('__bn_iframe_post', function(ev) {
    var detail = ev && ev.detail;
    if (!detail) return;
    var id = detail.id;
    var sitekey = detail.sitekey;
    var packedPayload = detail.packedPayload;       // Uint8Array — caller-encoded msgpack of payload
    var packedHeader = detail.packedHeader;          // Uint8Array — caller-built msgpack array prefix bytes
    var reply = function(d) {
      try { document.dispatchEvent(new CustomEvent('__bn_iframe_post_resp', { detail: Object.assign({ id: id }, d) })); }
      catch (e) {}
    };
    (async function() {
      if (typeof window.hsw !== 'function') { reply({ ok: false, error: 'no hsw' }); return; }
      try {
        var enc = await window.hsw(1, packedPayload);
        var encU8 = enc instanceof Uint8Array ? enc : new Uint8Array(enc);
        // Header expects [str(spec), bin(enc)] msgpack. We assemble in iframe:
        // 0x92 (fixarray of 2), then specStr packed, then bin(enc).
        // Caller passes specStr directly; we msgpack it here.
        var specStr = detail.specStr;
        var encoder = new TextEncoder();
        var specBytes = encoder.encode(specStr);
        // str format: if length < 32, use 0xa0|len; else use str8/16/32 prefix
        var strHeader;
        if (specBytes.length < 32) strHeader = new Uint8Array([0xa0 | specBytes.length]);
        else if (specBytes.length < 256) strHeader = new Uint8Array([0xd9, specBytes.length]);
        else if (specBytes.length < 65536) strHeader = new Uint8Array([0xda, (specBytes.length >> 8) & 0xff, specBytes.length & 0xff]);
        else strHeader = new Uint8Array([0xdb, (specBytes.length >>> 24) & 0xff, (specBytes.length >>> 16) & 0xff, (specBytes.length >>> 8) & 0xff, specBytes.length & 0xff]);
        // hCaptcha expects msgpack EXT type 0x12 (NOT bin). msgpack ext format:
        //   ext8:  d7 LEN(1) TYPE
        //   ext16: c8 LEN(2) TYPE
        //   ext32: c9 LEN(4) TYPE
        // (fixext1/2/4/8/16 d4/d5/d6/d7/d8 use fixed lengths, not for general use here)
        var binHeader;
        if (encU8.length < 256) binHeader = new Uint8Array([0xc7, encU8.length, 0x12]);
        else if (encU8.length < 65536) binHeader = new Uint8Array([0xc8, (encU8.length >> 8) & 0xff, encU8.length & 0xff, 0x12]);
        else binHeader = new Uint8Array([0xc9, (encU8.length >>> 24) & 0xff, (encU8.length >>> 16) & 0xff, (encU8.length >>> 8) & 0xff, encU8.length & 0xff, 0x12]);
        var totalLen = 1 + strHeader.length + specBytes.length + binHeader.length + encU8.length;
        var body = new Uint8Array(totalLen);
        var off = 0;
        body[off++] = 0x92;
        body.set(strHeader, off); off += strHeader.length;
        body.set(specBytes, off); off += specBytes.length;
        body.set(binHeader, off); off += binHeader.length;
        body.set(encU8, off);
        var r = await fetch('https://api.hcaptcha.com/getcaptcha/' + sitekey, {
          method: 'POST', credentials: 'include',
          headers: { 'accept': 'application/json, application/octet-stream', 'content-type': 'application/octet-stream' },
          body: body,
        });
        var ab = await r.arrayBuffer();
        var u8 = new Uint8Array(ab);
        var asText = '';
        try { asText = new TextDecoder('utf-8', { fatal: false }).decode(u8.slice(0, Math.min(u8.length, 800))); } catch (e) {}
        // Try to decrypt server response via hsw(0, X). If response is JSON
        // (challenge / failure), it'll throw or return non-Uint8Array.
        var decryptedJson = null;
        if (!asText.startsWith('{')) {
          try {
            var dec = await window.hsw(0, u8);
            if (dec instanceof Uint8Array) {
              // dec is a msgpack blob; pass back as base64 and the caller
              // can msgpack-decode in Node. Also try simple ASCII preview.
              decryptedJson = btoa(String.fromCharCode.apply(null, dec.slice(0, Math.min(dec.length, 200000))));
            }
          } catch (e) { /* decrypt failed; pass raw */ }
        }
        reply({
          ok: true, status: r.status, contentType: r.headers.get('content-type'),
          bodyLen: u8.length,
          bodyText: asText,
          bodyB64: btoa(String.fromCharCode.apply(null, u8.slice(0, Math.min(u8.length, 4096)))),
          encLen: encU8.length,
          totalBodyLen: totalLen,
          decryptedB64: decryptedJson,
        });
      } catch (e) { reply({ ok: false, error: String(e && e.message || e) }); }
    })();
  }, false);

  // Bridge: isolated world dispatches __bn_hsw_call CustomEvent on document,
  // main-world listener (here) calls window.hsw and replies via __bn_hsw_resp.
  // CustomEvent.detail crosses world boundaries via structured cloning.
  document.addEventListener('__bn_hsw_call', function(ev) {
    var detail = ev && ev.detail;
    if (!detail) return;
    var id = detail.id;
    var jwt = detail.jwt;
    var opts = detail.opts;
    var reply = function(d) {
      try { document.dispatchEvent(new CustomEvent('__bn_hsw_resp', { detail: Object.assign({ id: id }, d) })); }
      catch (e) {}
    };
    if (typeof window.hsw !== 'function') { reply({ ok: false, hasHsw: false, error: 'window.hsw is not a function' }); return; }
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    Promise.resolve().then(function() { return window.hsw(jwt, opts); }).then(function(proof) {
      reply({
        ok: true, hasHsw: true,
        proof: typeof proof === 'string' ? proof : null,
        proofLen: typeof proof === 'string' ? proof.length : -1,
        durationMs: Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - t0),
      });
    }).catch(function(e) {
      reply({ ok: false, hasHsw: true, error: String(e && e.message || e), durationMs: Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - t0) });
    });
  }, false);

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
              // Result might be a number (WASM ABI), boolean, string, Promise, or void
              var resultSummary;
              if (result === undefined) resultSummary = { type: 'undefined' };
              else if (typeof result === 'number') resultSummary = { type: 'number', val: result };
              else if (typeof result === 'boolean') resultSummary = { type: 'boolean', val: result };
              else if (typeof result === 'string') resultSummary = { type: 'string', val: result.slice(0, 200), len: result.length };
              else if (typeof result === 'bigint') resultSummary = { type: 'bigint', val: String(result) };
              else if (result === null) resultSummary = { type: 'null' };
              else if (typeof result === 'object' && typeof result.then === 'function') resultSummary = { type: 'promise' };
              else resultSummary = { type: typeof result, ctor: result && result.constructor && result.constructor.name };
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
