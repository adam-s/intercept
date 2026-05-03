/**
 * Try loading inline.js (challenge mode) AND hsw.js into the SAME sandbox.
 * If inline.js sets up _sharedLibs / __wdata / etc that hsw consumes,
 * the proof should grow.
 */

import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const BUNDLE_HASH = 'c6e277da86802178b920b24f7bd79dd5d0c81e0d';
const SITEKEY = '0c6a1e45-75d7-43cc-b836-a0c9d886b8ee';
const HOST = 'build.nvidia.com';

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
sandbox.atob = (x) => Buffer.from(x, 'base64').toString('binary');
sandbox.btoa = (x) => Buffer.from(x, 'binary').toString('base64');
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
	dispatchEvent: () => true,
	referrer: 'https://build.nvidia.com/openai/gpt-oss-20b',
	location: {
		href: 'https://newassets.hcaptcha.com/captcha/v1/' + BUNDLE_HASH + '/static/hcaptcha.html',
	},
	cookie: '',
	readyState: 'complete',
	visibilityState: 'visible',
	hidden: false,
	hasFocus: () => true,
};
const HASH = `frame=challenge&id=0gtest&host=${HOST}&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=${SITEKEY}&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com`;
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
sandbox.parent = { postMessage: () => {} };
sandbox.outerWidth = 1024;
sandbox.outerHeight = 576;
sandbox.innerWidth = 1024;
sandbox.innerHeight = 576;
sandbox.devicePixelRatio = 2;
sandbox.scrollX = 0;
sandbox.scrollY = 0;
sandbox.Intl = Intl;
sandbox.clientInformation = sandbox.navigator;
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
	sandbox[C] = () => {};
}
sandbox.MutationObserver = function () {
	this.observe = () => {};
	this.disconnect = () => {};
};
sandbox.IntersectionObserver = function () {
	this.observe = () => {};
	this.disconnect = () => {};
};
sandbox.ResizeObserver = function () {
	this.observe = () => {};
	this.disconnect = () => {};
};
sandbox.Worker = () => {
	throw new Error('Worker');
};
sandbox.fetch = () => new Promise(() => {});
sandbox.URL = URL;
sandbox.URLSearchParams = URLSearchParams;
sandbox.Blob = () => {};
sandbox.Image = () => {};
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
sandbox.postMessage = () => {};
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

// Load inline.js FIRST as challenge frame — sets up _sharedLibs etc
console.log('loading inline.js as challenge frame…');
try {
	new vm.Script(readFileSync('/tmp/build-nvidia-bundles/hcaptcha/inline.js', 'utf8'), {
		filename: 'inline.js',
	}).runInContext(ctx, { timeout: 10_000 });
} catch (e) {
	console.log('  inline init error (expected):', e.message?.slice(0, 80));
}
console.log(
	`  _sharedLibs: ${typeof sandbox._sharedLibs} keys=${sandbox._sharedLibs ? Object.keys(sandbox._sharedLibs) : 'n/a'}`,
);

// Wait briefly for any deferred init to flush
await new Promise((r) => setTimeout(r, 1500));
console.log(`  after 1.5s _sharedLibs: ${typeof sandbox._sharedLibs}`);

// THEN load hsw.js into the same context
console.log('\nloading hsw.js into same context…');
new vm.Script(readFileSync('/tmp/hsw.js', 'utf8'), { filename: 'hsw.js' }).runInContext(ctx);
console.log(`  hsw: ${typeof sandbox.hsw}`);

await sandbox.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');

const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));

// Try at increasing wait times
for (const waitMs of [0, 500, 2000, 5000, 10000]) {
	await new Promise((r) => setTimeout(r, waitMs));
	const out = await sandbox.hsw(jwt, opts);
	console.log(`after wait ${waitMs}ms: proof ${out.length} (target 19924)`);
}
