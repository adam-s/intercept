import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const win = new Window({
	url: 'https://newassets.hcaptcha.com/captcha/v1/c6e277da86802178b920b24f7bd79dd5d0c81e0d/static/hcaptcha.html#frame=challenge&id=0gtest&host=build.nvidia.com&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=0c6a1e45-75d7-43cc-b836-a0c9d886b8ee&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com',
});
win.document.documentElement.setAttribute(
	'data-id',
	'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d',
);

// Provide a Worker that actually works (uses worker_threads under the hood)
win.Worker = class WebWorker {
	constructor(_scriptUrl) {
		// Translate Blob URL or string to actual worker
		this._listeners = {};
		// Simulate: a Worker that just postMessages back what's sent (no-op)
		this._worker = null; // We won't actually start a worker
		setTimeout(() => {
			// Fire ready event
		}, 0);
	}
	postMessage(msg) {
		setTimeout(() => {
			const evt = { data: msg };
			(this._listeners.message || []).forEach((l) => {
				l(evt);
			});
		}, 0);
	}
	addEventListener(type, fn) {
		if (!this._listeners[type]) this._listeners[type] = [];
		this._listeners[type].push(fn);
	}
	removeEventListener(type, fn) {
		if (this._listeners[type]) {
			this._listeners[type] = this._listeners[type].filter((l) => l !== fn);
		}
	}
	terminate() {}
};
// Also URL.createObjectURL / Blob need to support being arg to Worker
const realCreateObjURL = win.URL.createObjectURL;
win.URL.createObjectURL = (blob) => {
	if (realCreateObjURL)
		try {
			return realCreateObjURL(blob);
		} catch {}
	return 'blob:fake';
};

const orig = win.crypto.getRandomValues.bind(win.crypto);
let rngCount = 0;
win.crypto.getRandomValues = (buf) => {
	rngCount++;
	return orig(buf);
};

win.eval(readFileSync('/tmp/hsw.js', 'utf8'));
await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
rngCount = 0;
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof = await win.hsw(jwt, opts);
console.log(`happy-dom + Worker stub: proof=${proof.length}, rng=${rngCount}`);

await win.close();
