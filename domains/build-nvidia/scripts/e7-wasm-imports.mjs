import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const win = new Window({
  url: 'https://newassets.hcaptcha.com/captcha/v1/c6e277da86802178b920b24f7bd79dd5d0c81e0d/static/hcaptcha.html#frame=challenge&id=0gtest&host=build.nvidia.com&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=0c6a1e45-75d7-43cc-b836-a0c9d886b8ee&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com',
});
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');
win.WebAssembly = WebAssembly;

// Trace WASM imports - intercept the imports object passed to instantiate
const origInstantiate = WebAssembly.instantiate;
let importCalls = {};
let importExports = null;
win.WebAssembly = new Proxy(WebAssembly, {
  get(t, p) {
    if (p === 'instantiate') {
      return function(buffer, importObject) {
        // Wrap each import function
        const wrappedImports = {};
        for (const ns in importObject) {
          wrappedImports[ns] = {};
          for (const fn in importObject[ns]) {
            const orig = importObject[ns][fn];
            if (typeof orig === 'function') {
              wrappedImports[ns][fn] = function(...args) {
                importCalls[fn] = (importCalls[fn] || 0) + 1;
                return orig.apply(this, args);
              };
            } else {
              wrappedImports[ns][fn] = orig;
            }
          }
        }
        return origInstantiate(buffer, wrappedImports).then(r => {
          importExports = r.instance.exports;
          // Wrap exports too
          const wrappedExports = {};
          for (const k in importExports) {
            const v = importExports[k];
            if (typeof v === 'function') {
              wrappedExports[k] = function(...args) {
                if (k === 'ec' || k === 'decrypt_resp_data' || k === 'encrypt_req_data') {
                  console.log(`WASM EXPORT ${k} called with args types:`, args.map(a => typeof a === 'object' ? a?.constructor?.name : typeof a));
                  if (k === 'ec') console.log(`  args[0] (JSON) length: ${args[0]?.length}, args[1] (time): ${args[1]}, args[3] (I_): ${args[3]}`);
                }
                const start = performance.now();
                const result = v.apply(this, args);
                if (k === 'ec') console.log(`  ec returned: type=${typeof result} took ${(performance.now()-start).toFixed(2)}ms`);
                return result;
              };
            } else {
              wrappedExports[k] = v;
            }
          }
          return { instance: { exports: wrappedExports }, module: r.module };
        });
      };
    }
    return Reflect.get(t, p);
  }
});

win.eval(readFileSync('/tmp/hsw.js', 'utf8'));
console.log('bootstrap...');
await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');

console.log('\nimport calls during bootstrap:', importCalls);
importCalls = {};

console.log('\nproof...');
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof = await win.hsw(jwt, opts);
console.log(`proof: ${proof.length}`);
console.log('import calls during proof:', importCalls);

await win.close();
