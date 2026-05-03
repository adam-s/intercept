import { readFileSync, writeFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { createHash } from 'node:crypto';

const win = new Window({ url: 'https://newassets.hcaptcha.com/' });
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');
win.WebAssembly = WebAssembly;

let nodeBuf = null;
const orig = WebAssembly.instantiate;
win.WebAssembly = new Proxy(WebAssembly, {
  get(t, p) {
    if (p === 'instantiate') {
      return function(buffer, importObject) {
        nodeBuf = buffer;
        return orig(buffer, importObject);
      };
    }
    return Reflect.get(t, p);
  }
});

win.eval(readFileSync('/tmp/hsw.js', 'utf8'));
await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');

if (nodeBuf) {
  const u8 = new Uint8Array(nodeBuf);
  const buf = Buffer.from(u8);
  const sha = createHash('sha256').update(buf).digest('hex');
  console.log(`Node WASM buffer: ${u8.byteLength} bytes, sha256=${sha}`);
  console.log(`first 32 hex: ${buf.slice(0,32).toString('hex')}`);
  console.log(`last 32 hex: ${buf.slice(-32).toString('hex')}`);
  // Save for comparison
  writeFileSync('/tmp/node-wasm.bin', buf);
}
await win.close();
