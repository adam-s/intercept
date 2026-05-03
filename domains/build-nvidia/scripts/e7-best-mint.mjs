import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { decode, encode } from '@msgpack/msgpack';
import msgpackLite from 'msgpack-lite';

const SITEKEY = '0c6a1e45-75d7-43cc-b836-a0c9d886b8ee';
const HOST = 'build.nvidia.com';
const BUNDLE_HASH = 'c6e277da86802178b920b24f7bd79dd5d0c81e0d';

// ─── Build best-effort happy-dom + full polyfills ──────────────────
const win = new Window({
  url: `https://newassets.hcaptcha.com/captcha/v1/${BUNDLE_HASH}/static/hcaptcha.html#frame=challenge&id=0gtest&host=${HOST}&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=${SITEKEY}&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com`,
});
win.document.documentElement.setAttribute('data-id', `hcaptcha-frame-${BUNDLE_HASH}`);
win.WebAssembly = WebAssembly;

// Add Chrome-shaped navigator extras
win.eval(`
const extras = {
  bluetooth:{},clipboard:{},connection:{effectiveType:'4g',downlink:10,rtt:50,saveData:false},credentials:{},devicePosture:{},geolocation:{},gpu:{},hid:{},ink:{},keyboard:{},locks:{},login:{},managed:{},mediaCapabilities:{},mediaDevices:{},mediaSession:{},permissions:{},presentation:{},scheduling:{},serial:{},serviceWorker:{},storage:{},storageBuckets:{},usb:{},userActivation:{},virtualKeyboard:{},wakeLock:{},webkitTemporaryStorage:{},webkitPersistentStorage:{},windowControlsOverlay:{},xr:{},protectedAudience:{},
  appCodeName:'Mozilla',appName:'Netscape',appVersion:'5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  product:'Gecko',productSub:'20030107',vendor:'Google Inc.',vendorSub:'',platform:'MacIntel',
  language:'en-US',languages:['en-US'],onLine:true,doNotTrack:null,
  hardwareConcurrency:12,deviceMemory:8,maxTouchPoints:0,cookieEnabled:true,webdriver:false,pdfViewerEnabled:false,
  deprecatedRunAdAuctionEnforcesKAnonymity:false,
  userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  getBattery:()=>Promise.resolve({level:1,charging:true,addEventListener(){},removeEventListener(){}}),
  getGamepads:()=>[],vibrate:()=>true,sendBeacon:()=>true,javaEnabled:()=>false,
  userAgentData:{
    brands:[{brand:'Not:A-Brand',version:'99'},{brand:'Google Chrome',version:'145'},{brand:'Chromium',version:'145'}],
    mobile:false,platform:'macOS',
    getHighEntropyValues:()=>Promise.resolve({architecture:'arm',bitness:'64',brands:[],fullVersionList:[],mobile:false,model:'',platform:'macOS',platformVersion:'14.6.0',uaFullVersion:'145.0.0.0',wow64:false}),
    toJSON:function(){return{brands:this.brands,mobile:this.mobile,platform:this.platform};},
  },
  plugins:{length:0},mimeTypes:{length:0},
};
for (const k in extras) {
  try { Object.defineProperty(navigator, k, {value:extras[k],writable:true,enumerable:true,configurable:true}); } catch(e){}
}
`);

// Load hsw.js
win.eval(readFileSync('/tmp/hsw.js', 'utf8'));
console.log('hsw loaded:', typeof win.hsw);

// Bootstrap
console.log('\n--- bootstrap ---');
const boot = await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
console.log(`bootstrap: ${typeof boot} len=${boot?.length}`);

// ─── POST checksiteconfig (Node fetch with cookie jar) ─────────────
console.log('\n--- POST /checksiteconfig ---');
const cookieJar = new Map();
const fetchWithCookies = async (url, opts = {}) => {
  const cookieHeader = [...cookieJar.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
  const headers = { ...(opts.headers || {}), ...(cookieHeader ? { cookie: cookieHeader } : {}) };
  const res = await fetch(url, { ...opts, headers });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const sc of setCookie || []) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (m) cookieJar.set(m[1], m[2]);
  }
  return res;
};

const r1 = await fetchWithCookies(
  `https://api.hcaptcha.com/checksiteconfig?v=${BUNDLE_HASH}&host=${HOST}&sitekey=${SITEKEY}&sc=1&swa=1&spst=1`,
  { method: 'POST', headers: { accept: 'application/json', 'content-type': 'text/plain', origin: 'https://newassets.hcaptcha.com', referer: 'https://newassets.hcaptcha.com/' } },
);
const j1 = await r1.json();
console.log(`status=${r1.status}, cookies=${[...cookieJar.keys()]}`);
console.log(`features=${JSON.stringify(j1.features)}`);
const spec = j1.c;
if (!spec) { console.log('no spec — bail'); process.exit(1); }

// ─── Compute proof using HappyDOM hsw ─────────────────────────────
console.log('\n--- compute proof ---');
const proofOpts = { href: `https://${HOST}/openai/gpt-oss-20b`, ardata: null, vm_data: null, uj_data: null, errors: [] };
const tProof = Date.now();
const proof = await win.hsw(spec.req, proofOpts);
console.log(`proof: len=${proof?.length} (${Date.now()-tProof}ms)`);

// ─── Build payload + encrypt + POST ───────────────────────────────
const payload = {
  v: BUNDLE_HASH, sitekey: SITEKEY, host: HOST, hl: 'en',
  motionData: JSON.stringify({
    st: Date.now()-5000,
    mm: [[100,200,100],[110,210,200],[120,220,300]], mm_mp: 0.5,
    md: [[100,200,50]], md_mp: 0.4, mu: [[120,220,350]], mu_mp: 0.3, v: 1,
    topLevel: { st: Date.now()-6000, sc: { availWidth: 1024, availHeight: 576 } },
    session: [], widgetList: ['e7w'], widgetId: 'e7w',
    href: `https://${HOST}/openai/gpt-oss-20b`,
    prev: { escaped:false,passed:false,expiredChallenge:false,expiredResponse:false },
  }),
  pdc: '{}', pem: JSON.stringify({ csc: 100, csch: 'api.hcaptcha.com', cscrt: 0, cscft: 100 }),
  n: proof, e: null,
};
console.log(`\n--- encrypt ---`);
const enc = await win.hsw(1, encode(payload));
console.log(`encrypted: ${enc?.byteLength}`);

const body = msgpackLite.encode([JSON.stringify(spec), enc]);
console.log(`request body: ${body.byteLength}`);

console.log('\n--- POST /getcaptcha ---');
const r2 = await fetchWithCookies(`https://api.hcaptcha.com/getcaptcha/${SITEKEY}`, {
  method: 'POST',
  headers: { accept: 'application/json, application/octet-stream', 'content-type': 'application/octet-stream', origin: 'https://newassets.hcaptcha.com', referer: 'https://newassets.hcaptcha.com/' },
  body,
});
const respBuf = new Uint8Array(await r2.arrayBuffer());
console.log(`status=${r2.status}, content-type=${r2.headers.get('content-type')}, ${respBuf.byteLength} bytes`);
console.log(`first 64 hex: ${Buffer.from(respBuf).slice(0, 64).toString('hex')}`);

// Try decode
const asText = Buffer.from(respBuf).toString('utf8');
if (asText.startsWith('{')) {
  const j = JSON.parse(asText);
  console.log('\n--- PLAINTEXT JSON ---');
  console.log(JSON.stringify(j, (_k, v) => typeof v === 'string' && v.length > 80 ? v.slice(0,40)+`…[${v.length}]` : v, 2).slice(0, 600));
  if (j.success === false) console.log(`\n→ DOWNGRADED. error-codes=${JSON.stringify(j['error-codes'])}`);
} else {
  try {
    const dec = await win.hsw(0, respBuf);
    if (dec instanceof Uint8Array) {
      const obj = decode(dec);
      console.log('\n--- DECRYPTED ---');
      console.log(JSON.stringify(obj, (_k, v) => typeof v === 'string' && v.length > 80 ? v.slice(0,40)+`…[${v.length}]` : v, 2));
      if (obj?.generated_pass_UUID) {
        console.log('\n*** TOKEN MINTED FROM PURE NODE: ***');
        console.log(obj.generated_pass_UUID);
      }
    }
  } catch (e) { console.log('decrypt failed:', e.message); }
}

await win.close();
