import { Window } from 'happy-dom';
const win = new Window({ url: 'https://newassets.hcaptcha.com/' });
win.WebAssembly = WebAssembly;
const navKeys = win.eval(`(() => { const n = navigator; const all = []; for (const k in n) all.push(k); return all; })()`);
console.log(`our navigator (happy-dom) has ${navKeys.length} keys:`);
console.log(navKeys.sort().join('\n'));
await win.close();
