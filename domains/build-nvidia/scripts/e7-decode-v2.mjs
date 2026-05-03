import { readFileSync, writeFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://newassets.hcaptcha.com/' });
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');
win.WebAssembly = WebAssembly;

let src = readFileSync('/tmp/hsw.js', 'utf8');

// Patch: inject `window.__bn_IE=IE;window.__bn_vf=vf;window.__bn_Uf=Uf;window.__bn_Yu=Yu;window.__bn_Qi=Qi;`
// after the line where Yu is defined (we know offset 893567 + 11780 = 905347 is end of Yu)
// Inject right before the IIFE closes

// Find IIFE close: the bundle ends with `}();`. Find the LAST `}();`
const tailRe = /}\(\);?\s*$/m;
const m = tailRe.exec(src);
if (!m) { console.error('no IIFE close found'); process.exit(1); }
const exposureCode = `;window.__bn_IE=IE;window.__bn_vf=vf;window.__bn_Uf=Uf;window.__bn_Yu=Yu;window.__bn_Qi=Qi;window.__bn_TG=TG;window.__bn_aV=aV;`;
src = src.slice(0, m.index) + exposureCode + src.slice(m.index);

win.eval(src);
console.log('hsw type:', typeof win.hsw);
console.log('exposed: __bn_IE=', typeof win.__bn_IE, '__bn_vf=', typeof win.__bn_vf, '__bn_Uf=', typeof win.__bn_Uf, '__bn_Yu=', typeof win.__bn_Yu);

await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');

// Now decode strings
console.log('\nDecoding IE(N) values:');
const decoded = {};
for (let n = 263; n < 1200; n++) {
  try {
    const s = win.__bn_IE(n);
    if (typeof s === 'string') decoded[n] = s;
  } catch {}
}
console.log(`Decoded ${Object.keys(decoded).length} strings`);

// Show interesting ones
console.log('\nKey strings:');
for (const n of [265, 266, 267, 268, 269, 270, 271, 295, 302, 313, 316, 317, 328, 337, 353, 359, 392, 393]) {
  console.log(`  IE(${n}) = "${decoded[n] || '?'}"`);
}

writeFileSync('/tmp/ie-table.json', JSON.stringify(decoded, null, 2));
await win.close();
