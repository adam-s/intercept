import { readFileSync, writeFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://newassets.hcaptcha.com/' });
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');
win.WebAssembly = WebAssembly;
win.eval(readFileSync('/tmp/hsw.js', 'utf8'));

// Bootstrap so internal state initializes (this also instantiates WASM)
await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');

// IE is a global in the bundle — try calling it for various N values
// IE takes (N, _) and returns a string from the decoded table
console.log('Testing IE(N) decoding...');
const decoded = {};
for (const n of [263, 264, 265, 266, 267, 268, 269, 270, 271, 295, 302, 313, 316, 317, 328, 337, 353, 359, 392, 393]) {
  try {
    const s = win.eval(`IE(${n})`);
    decoded[n] = s;
    console.log(`IE(${n}) = "${s}"`);
  } catch (e) {
    console.log(`IE(${n}) threw: ${e.message}`);
  }
}

writeFileSync('/tmp/ie-decoded.json', JSON.stringify(decoded, null, 2));
await win.close();
