import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const win = new Window({
  url: 'https://newassets.hcaptcha.com/captcha/v1/c6e277da86802178b920b24f7bd79dd5d0c81e0d/static/hcaptcha.html#frame=challenge&id=0gtest&host=build.nvidia.com&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=0c6a1e45-75d7-43cc-b836-a0c9d886b8ee&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com',
});
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');
win.WebAssembly = WebAssembly;

// Wrap WebAssembly.instantiate to log calls
const origInstantiate = WebAssembly.instantiate;
let wasmCallCount = 0;
let wasmResult = null;
let wasmError = null;
win.WebAssembly = {
  ...WebAssembly,
  instantiate: function(buffer, importObject) {
    wasmCallCount++;
    console.log(`WebAssembly.instantiate called! buffer size: ${buffer?.byteLength || buffer?.length}, imports keys: ${importObject ? Object.keys(importObject) : 'none'}`);
    return origInstantiate.call(WebAssembly, buffer, importObject)
      .then(r => { wasmResult = r; console.log('WASM instantiate SUCCESS, exports:', r?.instance?.exports ? Object.keys(r.instance.exports).slice(0, 10) : 'no exports'); return r; })
      .catch(e => { wasmError = e; console.log('WASM instantiate FAILED:', e.message); throw e; });
  },
  Module: WebAssembly.Module,
  Instance: WebAssembly.Instance,
  Memory: WebAssembly.Memory,
  Table: WebAssembly.Table,
  CompileError: WebAssembly.CompileError,
  RuntimeError: WebAssembly.RuntimeError,
  LinkError: WebAssembly.LinkError,
  validate: WebAssembly.validate,
  compile: WebAssembly.compile,
  instantiateStreaming: WebAssembly.instantiateStreaming,
};

win.eval(readFileSync('/tmp/hsw.js', 'utf8'));
console.log('\nbootstrap...');
const boot = await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
console.log(`bootstrap returned: ${typeof boot} len=${boot?.length}`);
console.log(`WASM calls so far: ${wasmCallCount}`);

console.log('\nproof...');
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof = await win.hsw(jwt, opts);
console.log(`proof: ${proof?.length}`);
console.log(`WASM calls total: ${wasmCallCount}`);

await win.close();
