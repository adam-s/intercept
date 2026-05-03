import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const win = new Window({
	url: 'https://newassets.hcaptcha.com/captcha/v1/c6e277da86802178b920b24f7bd79dd5d0c81e0d/static/hcaptcha.html#frame=challenge&id=0gtest&host=build.nvidia.com&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=0c6a1e45-75d7-43cc-b836-a0c9d886b8ee&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com',
});

// Set the bundle hash on documentElement
win.document.documentElement.setAttribute(
	'data-id',
	'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d',
);

// CRITICAL: happy-dom doesn't expose WebAssembly. hsw.js's fast path
// requires WebAssembly.instantiate(). Without it, hsw falls back to a
// JS-only path that produces ~58% size proof. Bridging Node's
// WebAssembly into the happy-dom window unlocks the fast path.
win.WebAssembly = WebAssembly;

// Count RNG calls
const orig = win.crypto.getRandomValues.bind(win.crypto);
let rngCount = 0;
win.crypto.getRandomValues = (buf) => {
	rngCount++;
	return orig(buf);
};

// Eval hsw.js inside happy-dom's window
win.eval(readFileSync('/tmp/hsw.js', 'utf8'));
console.log('hsw type:', typeof win.hsw);

await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
rngCount = 0;
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof = await win.hsw(jwt, opts);
console.log(`happy-dom: proof=${proof.length}, rng=${rngCount}`);

await win.close();
