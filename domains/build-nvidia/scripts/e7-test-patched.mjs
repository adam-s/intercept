import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://newassets.hcaptcha.com/' });
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');
win.WebAssembly = WebAssembly;

// Load patched WASM bytes
const patchedBytes = readFileSync('/tmp/wasm-disasm/hsw-patched.wasm');
console.log(`patched WASM size: ${patchedBytes.byteLength}`);

// Wrap WebAssembly.instantiate to substitute our patched bytes
const orig = WebAssembly.instantiate;
win.WebAssembly = new Proxy(WebAssembly, {
  get(t, p) {
    if (p === 'instantiate') {
      return function(buffer, importObject) {
        console.log(`intercepting instantiate: bufLen=${buffer?.byteLength}, swapping in patched bytes`);
        return orig(patchedBytes, importObject)
          .then(r => {
            console.log(`patched WASM instantiated, exports:`, Object.keys(r.instance.exports).slice(0, 12));
            return r;
          })
          .catch(e => { console.error('patched WASM failed:', e.message); throw e; });
      };
    }
    return Reflect.get(t, p);
  }
});

win.eval(readFileSync('/tmp/hsw.js', 'utf8'));
console.log('hsw type:', typeof win.hsw);

console.log('\nbootstrap...');
const boot = await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
console.log(`bootstrap len: ${boot?.length}`);

console.log('\nproof...');
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof = await win.hsw(jwt, opts);
console.log(`proof: ${proof?.length} (target: 19848, baseline: 13688)`);
await win.close();
