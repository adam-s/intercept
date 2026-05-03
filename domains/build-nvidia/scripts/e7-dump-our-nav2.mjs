import { Window } from 'happy-dom';
const win = new Window({ url: 'https://newassets.hcaptcha.com/' });
win.WebAssembly = WebAssembly;
const navInfo = win.eval(`(() => {
  const n = navigator;
  const own = Object.getOwnPropertyNames(n);
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(n));
  const all = new Set([...own, ...proto]);
  // Try forIn count
  let forInCount = 0;
  for (const k in n) forInCount++;
  // Try keys
  const keys = Object.keys(n);
  return { ownLen: own.length, protoLen: proto.length, allLen: all.size, forInCount, keysLen: keys.length, ownSample: own.slice(0,30), protoSample: proto.slice(0,30) };
})()`);
console.log(JSON.stringify(navInfo, null, 2));
await win.close();
