/**
 * E7-D-10: 100% Node hCaptcha mint, end-to-end.
 *
 * Two sandboxes:
 *   sandboxChallenge: runs inline.js as `frame=challenge` to produce vmdata
 *                     via Vi.collectVmData()
 *   sandboxProof:     runs hsw.js as the encrypt/decrypt + proof solver
 *
 * Flow:
 *   1. Bootstrap proof sandbox.
 *   2. POST /checksiteconfig → fresh spec.
 *   3. Bootstrap challenge sandbox; call collectVmData() to get vmdata.
 *   4. Compute proof in proof sandbox: hsw(jwt, {href, vm_data, …}).
 *   5. Encrypt payload with proof embedded as `n`.
 *   6. POST /getcaptcha with [spec_str, encrypted].
 *   7. Decrypt response. Print token if present.
 */

import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';
import { decode, encode } from '@msgpack/msgpack';
import msgpackLite from 'msgpack-lite';

// Suppress noisy unhandled errors from inline.js's deferred init
process.on('uncaughtException', (e) => console.log('  [uncaught]', e?.message?.slice(0, 80)));
process.on('unhandledRejection', (e) =>
	console.log('  [unhandled rejection]', String(e?.message || e).slice(0, 80)),
);

const HSW_PATH = '/tmp/hsw.js';
const INLINE_PATH = '/tmp/build-nvidia-bundles/hcaptcha/inline.js';
const SITEKEY = '0c6a1e45-75d7-43cc-b836-a0c9d886b8ee';
const HOST = 'build.nvidia.com';
const PARENT_URL = 'https://build.nvidia.com/openai/gpt-oss-20b';
const BUNDLE_HASH = 'c6e277da86802178b920b24f7bd79dd5d0c81e0d';
const WIDGET_ID = '0g' + Math.random().toString(36).slice(2, 12);

// ─── shared sandbox builder ────────────────────────────────────────────
function makeSandbox({ asChallenge = false } = {}) {
	const s = {};
	s.globalThis = s;
	s.console = console;
	s.setTimeout = setTimeout;
	s.clearTimeout = clearTimeout;
	s.setInterval = setInterval;
	s.clearInterval = clearInterval;
	s.queueMicrotask = queueMicrotask;
	s.Promise = Promise;
	s.performance = performance;
	s.crypto = webcrypto;
	s.TextEncoder = TextEncoder;
	s.TextDecoder = TextDecoder;
	s.atob = (x) => Buffer.from(x, 'base64').toString('binary');
	s.btoa = (x) => Buffer.from(x, 'binary').toString('base64');
	s.WebAssembly = WebAssembly;
	for (const T of [
		Uint8Array,
		Uint16Array,
		Uint32Array,
		Int8Array,
		Int16Array,
		Int32Array,
		Float32Array,
		Float64Array,
		ArrayBuffer,
		DataView,
		Map,
		Set,
		WeakMap,
		WeakSet,
	])
		s[T.name] = T;

	const docElement = {
		lang: 'en',
		__attrs: { 'data-id': `hcaptcha-frame-${BUNDLE_HASH}` },
		getAttribute(k) {
			return this.__attrs[k] ?? null;
		},
		setAttribute(k, v) {
			this.__attrs[k] = String(v);
		},
		appendChild() {},
		removeChild() {},
		insertBefore() {},
		style: {},
		classList: { add() {}, remove() {}, contains: () => false },
		dataset: {},
		addEventListener() {},
		removeEventListener() {},
		getBoundingClientRect: () => ({
			x: 0,
			y: 0,
			width: 1024,
			height: 576,
			top: 0,
			left: 0,
			right: 1024,
			bottom: 576,
		}),
		offsetWidth: 1024,
		offsetHeight: 576,
	};
	const makeEl = (tag) => ({
		tagName: String(tag).toUpperCase(),
		__attrs: {},
		__children: [],
		style: {},
		classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
		dataset: {},
		innerHTML: '',
		textContent: '',
		value: '',
		checked: false,
		disabled: false,
		getAttribute(k) {
			return this.__attrs[k] ?? null;
		},
		setAttribute(k, v) {
			this.__attrs[k] = String(v);
		},
		removeAttribute(k) {
			delete this.__attrs[k];
		},
		appendChild(c) {
			this.__children.push(c);
			return c;
		},
		removeChild() {},
		insertBefore() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => true,
		getBoundingClientRect: () => ({
			x: 0,
			y: 0,
			width: 100,
			height: 30,
			top: 0,
			left: 0,
			right: 100,
			bottom: 30,
		}),
		offsetWidth: 100,
		offsetHeight: 30,
		cloneNode: () => makeEl(tag),
		focus() {},
		blur() {},
		click() {},
	});

	s.document = {
		documentElement: docElement,
		body: makeEl('body'),
		head: makeEl('head'),
		createElement: makeEl,
		createElementNS: makeEl,
		createTextNode: (t) => ({ textContent: String(t) }),
		createComment: () => ({}),
		createEvent: () => ({ initEvent() {}, preventDefault() {}, stopPropagation() {} }),
		createDocumentFragment: () => makeEl('fragment'),
		querySelector: () => null,
		querySelectorAll: () => [],
		getElementById: () => null,
		getElementsByTagName: () => [],
		getElementsByClassName: () => [],
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => true,
		referrer: PARENT_URL, // ← tells the iframe what the parent's URL is
		location: {
			href: 'https://newassets.hcaptcha.com/captcha/v1/' + BUNDLE_HASH + '/static/hcaptcha.html',
		},
		cookie: '',
		readyState: 'complete',
		visibilityState: 'visible',
		hidden: false,
		hasFocus: () => true,
	};

	const HASH = `frame=${asChallenge ? 'challenge' : 'checkbox-invisible'}&id=${WIDGET_ID}&host=${HOST}&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=${SITEKEY}&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com`;
	s.location = {
		href: `https://newassets.hcaptcha.com/captcha/v1/${BUNDLE_HASH}/static/hcaptcha.html#${HASH}`,
		hash: '#' + HASH,
		host: 'newassets.hcaptcha.com',
		hostname: 'newassets.hcaptcha.com',
		origin: 'https://newassets.hcaptcha.com',
		pathname: `/captcha/v1/${BUNDLE_HASH}/static/hcaptcha.html`,
		protocol: 'https:',
		port: '',
		search: '',
		reload() {},
	};
	s.screen = {
		width: 1024,
		height: 576,
		availWidth: 1024,
		availHeight: 576,
		colorDepth: 24,
		pixelDepth: 24,
		orientation: { type: 'landscape-primary', angle: 0, onchange: null },
		isExtended: false,
		availLeft: 0,
		availTop: 0,
	};
	s.navigator = {
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
		appCodeName: 'Mozilla',
		appName: 'Netscape',
		appVersion:
			'5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
		product: 'Gecko',
		productSub: '20030107',
		vendor: 'Google Inc.',
		vendorSub: '',
		platform: 'MacIntel',
		language: 'en-US',
		languages: ['en-US'],
		onLine: true,
		doNotTrack: null,
		hardwareConcurrency: 16,
		deviceMemory: 8,
		maxTouchPoints: 0,
		cookieEnabled: true,
		webdriver: false,
		pdfViewerEnabled: false,
		connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
		userAgentData: {
			brands: [
				{ brand: 'Not:A-Brand', version: '99' },
				{ brand: 'Google Chrome', version: '145' },
				{ brand: 'Chromium', version: '145' },
			],
			mobile: false,
			platform: 'macOS',
			getHighEntropyValues: async () => ({
				architecture: 'arm',
				bitness: '64',
				brands: [],
				fullVersionList: [],
				mobile: false,
				model: '',
				platform: 'macOS',
				platformVersion: '14.6.0',
				uaFullVersion: '145.0.0.0',
				wow64: false,
			}),
			toJSON() {
				return { brands: this.brands, mobile: this.mobile, platform: this.platform };
			},
		},
		plugins: { length: 0 },
		mimeTypes: { length: 0 },
		scheduling: {},
		userActivation: {},
		geolocation: {},
		webkitTemporaryStorage: {},
		bluetooth: {},
		clipboard: {},
		credentials: {},
		keyboard: {},
		managed: {},
		mediaDevices: {},
		serviceWorker: {},
		virtualKeyboard: {},
		wakeLock: {},
		locks: {},
		storage: {},
		gpu: {},
		login: {},
		ink: {},
		mediaCapabilities: {},
		devicePosture: {},
		hid: {},
		mediaSession: {},
		permissions: {},
		presentation: {},
		serial: {},
		usb: {},
		xr: {},
		storageBuckets: {},
		sendBeacon: () => true,
		getBattery: () => Promise.resolve({ level: 1, charging: true }),
	};
	s.window = s;
	s.self = s;
	s.frames = s;
	s.top = s;
	s.parent = { postMessage: () => {} };
	s.outerWidth = 1024;
	s.outerHeight = 576;
	s.innerWidth = 1024;
	s.innerHeight = 576;
	s.devicePixelRatio = 2;
	s.scrollX = 0;
	s.scrollY = 0;
	s.Intl = Intl;
	s.clientInformation = s.navigator;
	for (const C of [
		'HTMLElement',
		'HTMLDivElement',
		'HTMLInputElement',
		'HTMLTextAreaElement',
		'HTMLButtonElement',
		'HTMLIFrameElement',
		'HTMLImageElement',
		'HTMLCanvasElement',
		'SVGElement',
		'Navigator',
		'Document',
		'Screen',
		'Performance',
		'SubtleCrypto',
		'RTCRtpReceiver',
		'RTCPeerConnection',
		'MessageChannel',
		'MessagePort',
		'BroadcastChannel',
		'Event',
		'CustomEvent',
		'MouseEvent',
		'KeyboardEvent',
		'TouchEvent',
		'PointerEvent',
		'FocusEvent',
		'InputEvent',
		'UIEvent',
		'ProgressEvent',
		'EventTarget',
		'AbortController',
		'AbortSignal',
		'XMLHttpRequest',
	]) {
		s[C] = () => {};
	}
	s.MutationObserver = function MutationObserver() {
		this.observe = () => {};
		this.disconnect = () => {};
	};
	s.IntersectionObserver = function IntersectionObserver() {
		this.observe = () => {};
		this.disconnect = () => {};
	};
	s.ResizeObserver = function ResizeObserver() {
		this.observe = () => {};
		this.disconnect = () => {};
	};
	s.Worker = function Worker() {
		throw new Error('Worker');
	};
	s.fetch = function fetch() {
		return new Promise(() => {});
	};
	s.URL = URL;
	s.URLSearchParams = URLSearchParams;
	s.Blob = function Blob() {};
	s.Image = function Image() {};
	s.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
	s.cancelAnimationFrame = clearTimeout;
	s.matchMedia = (q) => ({
		matches: false,
		media: q,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	});
	s.getComputedStyle = () => ({ getPropertyValue: () => '' });
	s.alert = () => {};
	s.confirm = () => false;
	s.prompt = () => null;
	s.addEventListener = () => {};
	s.removeEventListener = () => {};
	s.dispatchEvent = () => true;
	s.postMessage = () => {};
	for (const k of [
		'Error',
		'TypeError',
		'RangeError',
		'SyntaxError',
		'ReferenceError',
		'EvalError',
		'URIError',
		'JSON',
		'Math',
		'Object',
		'Array',
		'String',
		'Number',
		'Boolean',
		'Date',
		'RegExp',
		'Symbol',
		'Reflect',
		'Proxy',
		'Function',
		'Buffer',
		'Infinity',
		'NaN',
		'undefined',
		'isNaN',
		'isFinite',
		'parseInt',
		'parseFloat',
		'encodeURIComponent',
		'decodeURIComponent',
		'encodeURI',
		'decodeURI',
	]) {
		if (k in globalThis) s[k] = globalThis[k];
	}
	return s;
}

async function main() {
	// 1. Set up proof sandbox (hsw.js)
	console.log('=== Setup proof sandbox ===');
	const proofBox = makeSandbox({ asChallenge: false });
	const proofCtx = vm.createContext(proofBox);
	new vm.Script(readFileSync(HSW_PATH, 'utf8'), { filename: 'hsw.js' }).runInContext(proofCtx);
	console.log(`hsw loaded: ${typeof proofBox.hsw}`);
	const boot = await proofBox.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
	console.log(`bootstrap len=${boot.length}`);

	// 2. Set up challenge sandbox (inline.js, patched to expose Vi.collectVmData)
	console.log('\n=== Setup challenge sandbox (inline.js) ===');
	const inline = readFileSync(INLINE_PATH, 'utf8');
	const patched = inline.replace('Si=Vi.cr}catch', 'Si=Vi.cr,window.__bn_Vi=Vi}catch');
	if (patched === inline) throw new Error('patch site missing');

	const chalBox = makeSandbox({ asChallenge: true });
	const chalCtx = vm.createContext(chalBox);
	try {
		new vm.Script(patched, { filename: 'inline.js' }).runInContext(chalCtx, { timeout: 10_000 });
	} catch (e) {
		console.log(`inline.js load (errors expected during init): ${e.message?.slice(0, 80)}`);
	}
	if (typeof chalBox.__bn_Vi?.collectVmData !== 'function') {
		throw new Error('Vi.collectVmData not exposed');
	}
	console.log(`Vi.collectVmData type: ${typeof chalBox.__bn_Vi.collectVmData}`);

	// 3. POST /checksiteconfig (Bun fetch — TLS already proven irrelevant)
	console.log('\n=== POST /checksiteconfig ===');
	const cookieJar = new Map();
	const fetchWithCookies = async (url, opts = {}) => {
		const cookieHeader = [...cookieJar.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
		const headers = { ...(opts.headers || {}), ...(cookieHeader ? { cookie: cookieHeader } : {}) };
		const res = await fetch(url, { ...opts, headers });
		const setCookie = res.headers.getSetCookie
			? res.headers.getSetCookie()
			: [res.headers.get('set-cookie')].filter(Boolean);
		for (const sc of setCookie || []) {
			const m = sc.match(/^([^=]+)=([^;]*)/);
			if (m) cookieJar.set(m[1], m[2]);
		}
		return res;
	};
	const cscUrl = `https://api.hcaptcha.com/checksiteconfig?v=${BUNDLE_HASH}&host=${HOST}&sitekey=${SITEKEY}&sc=1&swa=1&spst=1`;
	const r1 = await fetchWithCookies(cscUrl, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'text/plain',
			origin: 'https://newassets.hcaptcha.com',
			referer: 'https://newassets.hcaptcha.com/',
		},
	});
	const j1 = await r1.json();
	console.log(
		`status=${r1.status}, cookies=${[...cookieJar.keys()].join(',')}, features=${JSON.stringify(j1.features)}`,
	);
	const spec = j1.c;
	if (!spec) throw new Error('no spec');
	console.log(`spec.req[:80]: ${spec.req.slice(0, 80)}…`);

	// 4. Generate vmdata in pure Node via the challenge sandbox.
	//    Wait first to let any deferred recorders populate.
	console.log('\n=== Generate vmdata in pure Node ===');
	await new Promise((r) => setTimeout(r, 2000));
	// Collect a few times to flush
	for (let i = 0; i < 3; i++) {
		const v = await chalBox.__bn_Vi.collectVmData();
		console.log(`  collect ${i + 1}: ${v?.length} bytes`);
	}
	const vmData = await chalBox.__bn_Vi.collectVmData();
	console.log(`final vm_data len: ${vmData.length}`);
	console.log(`vm_data preview: ${String(vmData).slice(0, 200)}…`);

	// 5. Compute proof
	console.log('\n=== Compute proof ===');
	const tProof = Date.now();
	const proof = await proofBox.hsw(spec.req, {
		href: PARENT_URL,
		ardata: null,
		vm_data: vmData,
		uj_data: null,
		errors: [],
	});
	console.log(`proof (${Date.now() - tProof}ms): len=${proof.length}`);

	// 6. Build payload + encrypt
	console.log('\n=== Encrypt payload ===');
	const payload = {
		v: BUNDLE_HASH,
		sitekey: SITEKEY,
		host: HOST,
		hl: 'en',
		motionData: JSON.stringify({
			st: Date.now() - 5000,
			mm: [
				[100, 200, 100],
				[110, 210, 200],
				[120, 220, 300],
			],
			mm_mp: 0.5,
			md: [[100, 200, 50]],
			md_mp: 0.4,
			mu: [[120, 220, 350]],
			mu_mp: 0.3,
			v: 1,
			topLevel: {
				st: Date.now() - 6000,
				sc: { availWidth: 1024, availHeight: 576, width: 1024, height: 576 },
			},
			session: [],
			widgetList: [WIDGET_ID],
			widgetId: WIDGET_ID,
			href: PARENT_URL,
			prev: { escaped: false, passed: false, expiredChallenge: false, expiredResponse: false },
		}),
		pdc: '{}',
		pem: JSON.stringify({ csc: 100, csch: 'api.hcaptcha.com', cscrt: 0, cscft: 100 }),
		n: proof,
		e: null,
	};
	const enc = await proofBox.hsw(1, encode(payload));
	console.log(`encrypted: ${enc.byteLength} bytes`);
	const body = msgpackLite.encode([JSON.stringify(spec), enc]);
	console.log(`request body: ${body.length} bytes`);

	// 7. POST /getcaptcha
	console.log('\n=== POST /getcaptcha ===');
	const r2 = await fetchWithCookies(`https://api.hcaptcha.com/getcaptcha/${SITEKEY}`, {
		method: 'POST',
		headers: {
			accept: 'application/json, application/octet-stream',
			'content-type': 'application/octet-stream',
			origin: 'https://newassets.hcaptcha.com',
			referer: 'https://newassets.hcaptcha.com/',
		},
		body,
	});
	const respBuf = new Uint8Array(await r2.arrayBuffer());
	console.log(
		`status=${r2.status}, content-type=${r2.headers.get('content-type')}, ${respBuf.byteLength} bytes`,
	);
	console.log(`first 32 hex: ${Buffer.from(respBuf).slice(0, 32).toString('hex')}`);

	// 8. Decode response
	const asText = Buffer.from(respBuf).toString('utf8');
	if (asText.startsWith('{')) {
		const j = JSON.parse(asText);
		console.log('\n--- PLAINTEXT JSON ---');
		console.log(
			JSON.stringify(
				j,
				(_k, v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 40) + `…[${v.length}]` : v),
				2,
			).slice(0, 600),
		);
		if (j.success === false)
			console.log(`\n→ STILL DOWNGRADED. error-codes=${JSON.stringify(j['error-codes'])}`);
		return;
	}
	try {
		const dec = await proofBox.hsw(0, respBuf);
		const obj = decode(dec);
		console.log('\n--- DECRYPTED RESPONSE ---');
		console.log(
			JSON.stringify(
				obj,
				(_k, v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 40) + `…[${v.length}]` : v),
				2,
			),
		);
		if (obj?.generated_pass_UUID) {
			console.log('\n*** 100% NODE TOKEN MINTED ***');
			console.log(obj.generated_pass_UUID);
			console.log(`\nlength: ${obj.generated_pass_UUID.length}`);
		}
	} catch (e) {
		console.log(`decrypt failed: ${e.message}`);
	}
}

main().catch((e) => {
	console.error('FAIL:', e);
	process.exit(1);
});
