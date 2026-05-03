import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://newassets.hcaptcha.com/' });
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');
win.WebAssembly = WebAssembly;

// Wait for WASM module instantiation, then introspect
const origInstantiate = WebAssembly.instantiate;
let modBuffer = null;
let importObjAtInstantiate = null;
win.WebAssembly = new Proxy(WebAssembly, {
  get(t, p) {
    if (p === 'instantiate') {
      return function(buffer, importObject) {
        if (!modBuffer) {
          modBuffer = buffer;
          importObjAtInstantiate = importObject;
        }
        return origInstantiate(buffer, importObject);
      };
    }
    return Reflect.get(t, p);
  }
});

win.eval(readFileSync('/tmp/hsw.js', 'utf8'));
await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');

if (modBuffer) {
  const mod = await WebAssembly.compile(modBuffer);
  const imports = WebAssembly.Module.imports(mod);
  const exports = WebAssembly.Module.exports(mod);
  console.log(`WASM module: ${imports.length} imports, ${exports.length} exports`);
  console.log('\nFirst 30 imports (in module order):');
  for (const imp of imports.slice(0, 30)) {
    console.log(`  ${imp.module}.${imp.name}: ${imp.kind}`);
  }
  console.log(`\n... ${imports.length - 30} more imports`);
  console.log('\nFirst 20 exports:');
  for (const exp of exports.slice(0, 20)) {
    console.log(`  ${exp.name}: ${exp.kind}`);
  }
}
await win.close();
