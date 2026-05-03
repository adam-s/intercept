/**
 * E7-D — V8 precise coverage of hsw.js execution. Produces per-function
 * call counts. Diffing coverage between (Node alone) vs (Node + inline.js)
 * reveals which functions hsw actually calls differently.
 *
 * Usage:
 *   node domains/build-nvidia/scripts/e7-coverage.mjs               # baseline
 *   node domains/build-nvidia/scripts/e7-coverage.mjs --with-inline  # inline.js loaded first
 */

import { webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import inspector from 'node:inspector/promises';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const WITH_INLINE = process.argv.includes('--with-inline');
const OUT = WITH_INLINE ? '/tmp/cov-with-inline.json' : '/tmp/cov-baseline.json';
const BUNDLE_HASH = 'c6e277da86802178b920b24f7bd79dd5d0c81e0d';

function makeSandbox() {
	const s = {};
	s.globalThis = s;
	s.console = { log: () => {}, warn: () => {}, error: () => {} };
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
	const docEl = {
		lang: 'en',
		__attrs: { 'data-id': `hcaptcha-frame-${BUNDLE_HASH}` },
		getAttribute(k) {
			return this.__attrs[k] ?? null;
		},
		setAttribute() {},
		appendChild() {},
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
		documentElement: docEl,
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
			href: `https://newassets.hcaptcha.com/captcha/v1/${BUNDLE_HASH}/static/hcaptcha.html`,
		},
		cookie: '',
		readyState: 'complete',
		visibilityState: 'visible',
		hidden: false,
		hasFocus: () => true,
	};
	const HASH = `frame=challenge&id=0gtest&host=build.nvidia.com&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=0c6a1e45-75d7-43cc-b836-a0c9d886b8ee&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com`;
	s.location = {
		href: `https://newassets.hcaptcha.com/captcha/v1/${BUNDLE_HASH}/static/hcaptcha.html#${HASH}`,
		hash: `#${HASH}`,
		host: 'newassets.hcaptcha.com',
		hostname: 'newassets.hcaptcha.com',
		origin: 'https://newassets.hcaptcha.com',
		pathname: '/x',
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
		appVersion: '5.0',
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
		connection: { effectiveType: '4g' },
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
		sendBeacon: () => true,
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
		'MutationObserver',
		'IntersectionObserver',
		'ResizeObserver',
		'EventTarget',
	])
		s[C] = () => {};
	s.MutationObserver = function () {
		this.observe = () => {};
		this.disconnect = () => {};
	};
	s.IntersectionObserver = function () {
		this.observe = () => {};
		this.disconnect = () => {};
	};
	s.ResizeObserver = function () {
		this.observe = () => {};
		this.disconnect = () => {};
	};
	s.Worker = () => {
		throw new Error('Worker');
	};
	s.fetch = () => new Promise(() => {});
	s.URL = URL;
	s.URLSearchParams = URLSearchParams;
	s.Blob = () => {};
	s.Image = () => {};
	s.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
	s.cancelAnimationFrame = clearTimeout;
	s.matchMedia = (q) => ({
		matches: false,
		media: q,
		addEventListener() {},
		removeEventListener() {},
	});
	s.getComputedStyle = () => ({ getPropertyValue: () => '' });
	s.addEventListener = () => {};
	s.removeEventListener = () => {};
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

const session = new inspector.Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

const sandbox = makeSandbox();
const ctx = vm.createContext(sandbox);

if (WITH_INLINE) {
	console.log('loading inline.js first…');
	try {
		new vm.Script(readFileSync('/tmp/build-nvidia-bundles/hcaptcha/inline.js', 'utf8'), {
			filename: 'inline.js',
		}).runInContext(ctx, { timeout: 10_000 });
	} catch {}
	await new Promise((r) => setTimeout(r, 1500));
}

console.log('loading hsw.js…');
new vm.Script(readFileSync('/tmp/hsw.js', 'utf8'), { filename: 'hsw.js' }).runInContext(ctx);

console.log('bootstrap…');
await sandbox.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');

// Reset coverage so we only capture the proof call
await session.post('Profiler.takePreciseCoverage'); // discard

console.log('proof…');
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const out = await sandbox.hsw(jwt, opts);
console.log(`proof: ${out.length}`);

const cov = await session.post('Profiler.takePreciseCoverage');
await session.post('Profiler.stopPreciseCoverage');
session.disconnect();

// Filter to only hsw.js coverage
const hswScripts = cov.result.filter((s) => s.url === 'hsw.js' || s.url.includes('hsw.js'));
console.log(`hsw scripts found: ${hswScripts.length}`);
const fns = hswScripts.flatMap((s) => s.functions);
console.log(`total functions covered: ${fns.length}`);
const executed = fns.filter((f) => f.ranges[0]?.count > 0);
console.log(`functions actually executed: ${executed.length}`);

writeFileSync(OUT, JSON.stringify({ proof_size: out.length, scripts: hswScripts }));
console.log(`saved to ${OUT}`);
