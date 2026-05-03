import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { decode, encode } from '@msgpack/msgpack';
import msgpackLite from 'msgpack-lite';

const SITEKEY = '0c6a1e45-75d7-43cc-b836-a0c9d886b8ee';
const HOST = 'build.nvidia.com';
const BUNDLE_HASH = 'c6e277da86802178b920b24f7bd79dd5d0c81e0d';

const win = new Window({
  url: `https://newassets.hcaptcha.com/captcha/v1/${BUNDLE_HASH}/static/hcaptcha.html#frame=challenge&id=0gtest&host=${HOST}&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=${SITEKEY}&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com`,
});
win.document.documentElement.setAttribute('data-id', `hcaptcha-frame-${BUNDLE_HASH}`);
win.WebAssembly = WebAssembly;

// Load PATCHED hsw.js (instanceof DOMClass → instanceof Object)
win.eval(readFileSync('/tmp/hsw-patched-v2.js', 'utf8'));
console.log('hsw type:', typeof win.hsw);

// Bootstrap
console.log('\n--- bootstrap ---');
const boot = await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
console.log(`bootstrap: len=${boot?.length}`);

// Quick proof test with captured JWT to compare size
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof1 = await win.hsw(jwt, opts);
console.log(`\nproof (with captured JWT): len=${proof1?.length} (target: 19848)`);

// Now do full pure-Node mint flow
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

console.log('\n--- POST /checksiteconfig ---');
const r1 = await fetchWithCookies(
  `https://api.hcaptcha.com/checksiteconfig?v=${BUNDLE_HASH}&host=${HOST}&sitekey=${SITEKEY}&sc=1&swa=1&spst=1`,
  { method: 'POST', headers: { accept: 'application/json', 'content-type': 'text/plain', origin: 'https://newassets.hcaptcha.com', referer: 'https://newassets.hcaptcha.com/' } },
);
const j1 = await r1.json();
console.log(`status=${r1.status}, features=${JSON.stringify(j1.features)}`);
const spec = j1.c;

console.log('\n--- compute proof for fresh spec ---');
const tProof = Date.now();
const proof = await win.hsw(spec.req, { href: `https://${HOST}/openai/gpt-oss-20b`, ardata: null, vm_data: null, uj_data: null, errors: [] });
console.log(`proof: len=${proof?.length} (${Date.now()-tProof}ms)`);

const payload = {
  v: BUNDLE_HASH, sitekey: SITEKEY, host: HOST, hl: 'en',
  motionData: JSON.stringify({
    st: Date.now()-5000, mm: [[100,200,100],[110,210,200]], mm_mp: 0.5,
    md: [[100,200,50]], md_mp: 0.4, mu: [[110,210,250]], mu_mp: 0.3, v: 1,
    topLevel: { st: Date.now()-6000, sc: { availWidth: 1024, availHeight: 576 } },
    session: [], widgetList: ['e7w'], widgetId: 'e7w',
    href: `https://${HOST}/openai/gpt-oss-20b`,
    prev: { escaped:false,passed:false,expiredChallenge:false,expiredResponse:false },
  }),
  pdc: '{}', pem: '{}', n: proof, e: null,
};
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
console.log(`status=${r2.status}, ${respBuf.byteLength} bytes`);

const asText = Buffer.from(respBuf).toString('utf8');
if (asText.startsWith('{')) {
  const j = JSON.parse(asText);
  console.log('plaintext json:', JSON.stringify(j).slice(0, 300));
} else {
  try {
    const dec = await win.hsw(0, respBuf);
    if (dec instanceof Uint8Array) {
      const obj = decode(dec);
      console.log('\n--- DECRYPTED ---');
      console.log(JSON.stringify(obj, (_k,v) => typeof v === 'string' && v.length > 80 ? v.slice(0,40)+`…[${v.length}]` : v, 2).slice(0, 600));
      if (obj?.generated_pass_UUID) {
        console.log('\n*** PURE NODE TOKEN MINTED ***');
        console.log(obj.generated_pass_UUID.slice(0, 80) + '…');
      }
    }
  } catch (e) { console.log('decrypt failed:', e?.message); }
}

await win.close();
