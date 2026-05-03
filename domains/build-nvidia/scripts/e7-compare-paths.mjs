import { readFileSync, writeFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://newassets.hcaptcha.com/' });
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');
win.WebAssembly = WebAssembly;

// Same wrap as wasm-import-tap, capturing all import calls in Node
const orig = WebAssembly.instantiate;
const nodeCalls = [];
win.WebAssembly = new Proxy(WebAssembly, {
  get(t, p) {
    if (p === 'instantiate') {
      return function(buffer, importObject) {
        const wrapped = {};
        for (const ns in importObject) {
          wrapped[ns] = {};
          for (const fn in importObject[ns]) {
            const o = importObject[ns][fn];
            if (typeof o !== 'function') { wrapped[ns][fn] = o; continue; }
            wrapped[ns][fn] = function(...args) {
              const r = o.apply(this, args);
              if (nodeCalls.length < 50000) {
                nodeCalls.push({ ns, fn, args: [...args], r: typeof r === 'number' ? r : (typeof r === 'boolean' ? `b:${r}` : (typeof r === 'string' ? `s:${r.slice(0,30)}` : typeof r)) });
              }
              return r;
            };
          }
        }
        return orig(buffer, wrapped);
      };
    }
    return Reflect.get(t, p);
  }
});

win.eval(readFileSync('/tmp/hsw.js', 'utf8'));
console.log('bootstrap...');
await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
const bootCount = nodeCalls.length;
console.log(`bootstrap: ${bootCount} import calls`);

const proofStart = nodeCalls.length;
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof = await win.hsw(jwt, opts);
const proofCount = nodeCalls.length - proofStart;
console.log(`proof: ${proofCount} import calls, proof_size=${proof?.length}`);

// Save Node's full call sequence
writeFileSync('/tmp/wasm-replay/node-imports.json', JSON.stringify(nodeCalls));
console.log(`saved ${nodeCalls.length} Node calls`);

// Compare to Chrome
const chrome = JSON.parse(readFileSync('/tmp/wasm-replay/chrome-imports.json'));
const chromeImports = chrome.filter(e => e.kind === 'import-call');
console.log(`Chrome had ${chromeImports.length} total import calls`);

// Find first divergence in call sequence (ns.fn name AND first arg)
console.log('\nFirst divergence (call-by-call):');
const minLen = Math.min(nodeCalls.length, chromeImports.length);
for (let i = 0; i < minLen; i++) {
  const c = chromeImports[i];
  const n = nodeCalls[i];
  if (c.ns !== n.ns || c.fn !== n.fn) {
    console.log(`  call #${i}: Chrome=${c.ns}.${c.fn}(${JSON.stringify(c.args)}) vs Node=${n.ns}.${n.fn}(${JSON.stringify(n.args)})`);
    // Show 5 calls before to give context
    console.log('  context (last 5 matching calls):');
    for (let j = Math.max(0, i-5); j < i; j++) {
      console.log(`    [${j}] Chrome: ${chromeImports[j].ns}.${chromeImports[j].fn}(${JSON.stringify(chromeImports[j].args)})`);
      console.log(`    [${j}] Node:   ${nodeCalls[j].ns}.${nodeCalls[j].fn}(${JSON.stringify(nodeCalls[j].args)})`);
    }
    break;
  }
}

// Also count how many calls match exactly (in order)
let matched = 0;
for (let i = 0; i < minLen; i++) {
  if (chromeImports[i].ns === nodeCalls[i].ns && chromeImports[i].fn === nodeCalls[i].fn) matched++;
  else break;
}
console.log(`\nFirst ${matched} calls match exactly in (ns,fn) — diverged at call #${matched}`);

await win.close();
