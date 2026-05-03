/**
 * E7-D-9: Generate vmdata in pure Node by loading inline.js as the
 * `challenge` iframe in a Node vm sandbox. The bundle's IIFE inspects
 * `document.documentElement.getAttribute("data-id")` and
 * `window.location.hash` to decide what role it's playing; we set both
 * to mimic a real challenge iframe.
 *
 * To extract the internal `Ci` (analytics-vm) tracker, we patch the
 * bundle source after the line `Ci=Vi.al,...` to ALSO assign Ci to
 * `window.__bn_Ci`, so we can call `__bn_Ci.getData()` from outside the
 * IIFE.
 */

import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';

const INLINE_JS = '/tmp/build-nvidia-bundles/hcaptcha/inline.js';
const SITEKEY = '0c6a1e45-75d7-43cc-b836-a0c9d886b8ee';
const HOST = 'build.nvidia.com';
const BUNDLE_HASH = 'c6e277da86802178b920b24f7bd79dd5d0c81e0d';
const WIDGET_ID = '0gtest12345e7';

// Patch bundle: expose Ci, Ti, Vi, Ei, Ai, Ri to window after the destructure.
// Original: `Ci=Vi.al,Ti=Vi.a,Ri=Vi.start,Vi.stop,Vi.j,_i=Vi.d,Si=Vi.cr`
// Insert assignments INSIDE the comma sequence (still expressions).
const inline = readFileSync(INLINE_JS, 'utf8');
const patchSite = 'Si=Vi.cr}catch';
const patched = inline.replace(
	patchSite,
	'Si=Vi.cr,window.__bn_Vi=Vi,window.__bn_Ci=Ci,window.__bn_Ti=Ti,window.__bn_Ei=Ei,window.__bn_Ai=Ai,window.__bn_Ri=Ri,window.__bn_Si=Si,window.__bn__i=_i}catch',
);
if (patched === inline) {
	console.error('FAIL: patch site not found');
	process.exit(1);
}

// Build a fairly fat sandbox — challenge frame inspects screen, navigator,
// etc., far more aggressively than the proof JS.
const sandbox = {};
sandbox.globalThis = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.setInterval = setInterval;
sandbox.clearInterval = clearInterval;
sandbox.queueMicrotask = queueMicrotask;
sandbox.Promise = Promise;
sandbox.performance = performance;
sandbox.crypto = webcrypto;
sandbox.TextEncoder = TextEncoder;
sandbox.TextDecoder = TextDecoder;
sandbox.atob = (s) => Buffer.from(s, 'base64').toString('binary');
sandbox.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
sandbox.WebAssembly = WebAssembly;
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
	sandbox[T.name] = T;

// DOM root — must respond to data-id query
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
	scrollWidth: 1024,
	scrollHeight: 576,
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
	dispatchEvent() {
		return true;
	},
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
	cloneNode() {
		return makeEl(tag);
	},
	focus() {},
	blur() {},
	click() {},
});

sandbox.document = {
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
	dispatchEvent() {
		return true;
	},
	referrer: 'https://build.nvidia.com/openai/gpt-oss-20b',
	location: {
		href: 'https://newassets.hcaptcha.com/captcha/v1/' + BUNDLE_HASH + '/static/hcaptcha.html',
	},
	cookie: '',
	readyState: 'complete',
	visibilityState: 'visible',
	hidden: false,
	hasFocus: () => true,
	__activeListeners: {},
};

const HASH = `frame=challenge&id=${WIDGET_ID}&host=${HOST}&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=${SITEKEY}&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com`;
sandbox.location = {
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

sandbox.screen = {
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
sandbox.navigator = {
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

sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.frames = sandbox;
sandbox.top = sandbox;
sandbox.parent = {
	postMessage: (msg, targetOrigin, transfer) => {
		console.log(
			`[parent.postMessage]`,
			typeof msg === 'object' ? JSON.stringify(msg).slice(0, 150) : String(msg).slice(0, 150),
		);
	},
};
sandbox.outerWidth = 1024;
sandbox.outerHeight = 576;
sandbox.innerWidth = 1024;
sandbox.innerHeight = 576;
sandbox.devicePixelRatio = 2;
sandbox.scrollX = 0;
sandbox.scrollY = 0;
sandbox.Intl = Intl;
sandbox.clientInformation = sandbox.navigator;
sandbox.HTMLElement = () => {};
sandbox.HTMLDivElement = () => {};
sandbox.HTMLInputElement = () => {};
sandbox.HTMLTextAreaElement = () => {};
sandbox.HTMLButtonElement = () => {};
sandbox.HTMLIFrameElement = () => {};
sandbox.HTMLImageElement = () => {};
sandbox.HTMLCanvasElement = () => {};
sandbox.SVGElement = () => {};
for (const C of [
	'Navigator',
	'Document',
	'Screen',
	'Performance',
	'SubtleCrypto',
	'RTCRtpReceiver',
	'RTCPeerConnection',
	'URLSearchParams',
	'MutationObserver',
	'IntersectionObserver',
	'ResizeObserver',
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
	sandbox[C] = sandbox[C] || (() => {});
}
sandbox.MutationObserver = function MutationObserver() {
	this.observe = () => {};
	this.disconnect = () => {};
};
sandbox.IntersectionObserver = function IntersectionObserver() {
	this.observe = () => {};
	this.disconnect = () => {};
};
sandbox.ResizeObserver = function ResizeObserver() {
	this.observe = () => {};
	this.disconnect = () => {};
};
sandbox.Worker = function Worker() {
	throw new Error('Worker');
};
// Stub fetch — bundle MAY try to call it. Log and return a never-resolving promise.
const fetchLog = [];
sandbox.fetch = function fetch(input, init) {
	const url = typeof input === 'string' ? input : input?.url || '';
	fetchLog.push({ url, method: init?.method || 'GET' });
	return new Promise(() => {}); // never resolves
};
sandbox.URL = URL;
sandbox.URLSearchParams = URLSearchParams;
sandbox.Blob = function Blob() {};
sandbox.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
sandbox.cancelAnimationFrame = clearTimeout;
sandbox.matchMedia = (q) => ({
	matches: false,
	media: q,
	addEventListener() {},
	removeEventListener() {},
	addListener() {},
	removeListener() {},
});
sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
sandbox.alert = () => {};
sandbox.confirm = () => false;
sandbox.prompt = () => null;
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.dispatchEvent = () => true;
sandbox.postMessage = (msg) =>
	console.log(
		`[self.postMessage]`,
		typeof msg === 'object' ? JSON.stringify(msg).slice(0, 150) : String(msg).slice(0, 150),
	);
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
	if (k in globalThis) sandbox[k] = globalThis[k];
}

const ctx = vm.createContext(sandbox);
console.log('loading inline.js (patched)…');
let loadErr = null;
try {
	new vm.Script(patched, { filename: 'inline.js' }).runInContext(ctx, { timeout: 10_000 });
} catch (e) {
	loadErr = e;
}
console.log(`load error: ${loadErr ? String(loadErr.message).slice(0, 300) : '<none>'}`);

console.log(`\nexposed globals after load:`);
const exposed = Object.keys(sandbox).filter((k) => k.startsWith('__bn_'));
for (const k of exposed) {
	const v = sandbox[k];
	console.log(
		`  ${k}: ${typeof v}${v && typeof v === 'object' ? ' keys=' + Object.keys(v).slice(0, 8).join(',') : ''}`,
	);
}

// The MOST interesting method: Vi.collectVmData
if (sandbox.__bn_Vi?.collectVmData) {
	console.log('\nCalling __bn_Vi.collectVmData() …');
	try {
		const r = sandbox.__bn_Vi.collectVmData();
		console.log(`collectVmData type: ${typeof r}`);
		if (r && typeof r.then === 'function') {
			r.then((v) =>
				console.log(`collectVmData resolved: ${JSON.stringify(v).slice(0, 800)}`),
			).catch((e) => console.log(`collectVmData rejected: ${e.message}`));
		} else {
			console.log(`collectVmData (sync): ${JSON.stringify(r).slice(0, 800)}`);
		}
	} catch (e) {
		console.log(`collectVmData threw: ${String(e?.message || e)}`);
	}
}

if (sandbox.__bn_Ci) {
	for (const m of ['getData', 'flush', 'consume', 'snapshot']) {
		if (typeof sandbox.__bn_Ci[m] === 'function') {
			try {
				const r = sandbox.__bn_Ci[m]();
				console.log(`Ci.${m}(): ${JSON.stringify(r).slice(0, 200)}`);
			} catch (e) {
				console.log(`Ci.${m} threw: ${e.message}`);
			}
		}
	}
	console.log('Ci all keys:', Object.keys(sandbox.__bn_Ci));
}

console.log('\nfetch attempts during init:', fetchLog.length);
for (const f of fetchLog.slice(0, 10)) console.log(`  ${f.method} ${f.url.slice(0, 80)}`);

// Wait a bit for any deferred init
await new Promise((r) => setTimeout(r, 1000));

console.log('\n=== After 1s settle ===');
if (sandbox.__bn_Ci) {
	try {
		const data = sandbox.__bn_Ci.getData();
		console.log(`Ci.getData() (after settle): JSON=${JSON.stringify(data).slice(0, 800)}`);
	} catch (e) {
		console.log(`Ci.getData threw: ${String(e?.message || e)}`);
	}
}
