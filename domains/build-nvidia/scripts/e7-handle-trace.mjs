import { readFileSync, writeFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://newassets.hcaptcha.com/' });
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');
win.WebAssembly = WebAssembly;

let src = readFileSync('/tmp/hsw.js', 'utf8');

// We need to instrument Qi (the handle array).
// Qi is defined somewhere — let's expose Qi too plus Uf which writes to it
const tailRe = /}\(\);?\s*$/m;
const m = tailRe.exec(src);
const exposureCode = `;window.__bn_Qi=Qi;window.__bn_Uf=Uf;window.__bn_vf=vf;window.__bn_IE=IE;window.__bn_Yu=Yu;`;
src = src.slice(0, m.index) + exposureCode + src.slice(m.index);

win.eval(src);

// Bootstrap
await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');

// Examine Qi (the handle array) to see what's at slots 1030-1055
const Qi = win.__bn_Qi;
console.log(`Qi length: ${Qi.length}, type: ${Qi.constructor.name}`);
console.log(`\nQi[1030..1060]:`);
for (let i = 1030; i < 1060; i++) {
  const v = Qi[i];
  let desc;
  if (v === undefined) desc = '<undefined>';
  else if (v === null) desc = '<null>';
  else if (typeof v === 'function') desc = `function(${v.name||'anon'})`;
  else if (typeof v === 'string') desc = `string(${v.length}): "${v.slice(0,60)}"`;
  else if (typeof v === 'number') desc = `number: ${v}`;
  else if (typeof v === 'boolean') desc = `bool: ${v}`;
  else if (typeof v === 'object') desc = `object(${v.constructor?.name || '?'}): keys=[${Object.keys(v).slice(0,5).join(',')}]${Object.keys(v).length>5?'...':''}`;
  else desc = String(v);
  console.log(`  [${i}]: ${desc}`);
}

// Specifically inspect handles that cb was called with: 1035, 1036, 1039, 1044, 1046, 1047, 1048, 1049, 1050, 1051
console.log('\nHandles cb was called with (Chrome trace):');
for (const i of [1035, 1036, 1039, 1044, 1046, 1047, 1048, 1049, 1050, 1051, 1052, 1054, 1055]) {
  const v = Qi[i];
  let desc;
  if (v === undefined) desc = '<undefined>';
  else if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v);
    desc = `${v.constructor?.name || 'obj'} (${keys.length} keys)`;
    if (keys.length < 30) desc += `: [${keys.join(',')}]`;
  } else {
    desc = `${typeof v}: ${String(v).slice(0, 80)}`;
  }
  console.log(`  Qi[${i}]: ${desc}`);
}

await win.close();
