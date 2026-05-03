import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const BUNDLE_HASH = 'c6e277da86802178b920b24f7bd79dd5d0c81e0d';

async function test(label, withInline) {
	let getRandomCount = 0;
	const sandbox = {};
	sandbox.globalThis = sandbox;
	sandbox.console = { log: () => {}, warn: () => {}, error: () => {} };
	sandbox.setTimeout = setTimeout;
	sandbox.clearTimeout = clearTimeout;
	sandbox.setInterval = setInterval;
	sandbox.clearInterval = clearInterval;
	sandbox.queueMicrotask = queueMicrotask;
	sandbox.Promise = Promise;
	sandbox.performance = performance;
	sandbox.crypto = {
		subtle: webcrypto.subtle,
		getRandomValues: (a) => {
			getRandomCount++;
			return webcrypto.getRandomValues(a);
		},
		randomUUID: () => webcrypto.randomUUID(),
	};
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
		getBoundingClientRect: () => ({ x: 0, y: 0, width: 1024, height: 576 }),
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
		removeAttribute() {},
		appendChild(c) {
			this.__children.push(c);
			return c;
		},
		removeChild() {},
		insertBefore() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => true,
		getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 30 }),
		offsetWidth: 100,
		offsetHeight: 30,
		cloneNode: () => makeEl(tag),
		focus() {},
		blur() {},
		click() {},
	});
	sandbox.document = {
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
		location: { href: 'https://newassets.hcaptcha.com/' },
		cookie: '',
		readyState: 'complete',
		visibilityState: 'visible',
		hidden: false,
		hasFocus: () => true,
	};
	const HASH = `frame=challenge&id=0gtest&host=build.nvidia.com&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=0c6a1e45-75d7-43cc-b836-a0c9d886b8ee&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com`;
	sandbox.location = {
		href: `https://newassets.hcaptcha.com/x#${HASH}`,
		hash: '#' + HASH,
		host: 'newassets.hcaptcha.com',
		hostname: 'newassets.hcaptcha.com',
		origin: 'https://newassets.hcaptcha.com',
		pathname: '/x',
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
		userAgent: 'Mozilla/5.0',
		language: 'en-US',
		languages: ['en-US'],
		platform: 'MacIntel',
		hardwareConcurrency: 16,
		deviceMemory: 16,
		maxTouchPoints: 0,
		cookieEnabled: true,
		webdriver: false,
		connection: {},
		userAgentData: {
			brands: [],
			mobile: false,
			platform: 'macOS',
			getHighEntropyValues: async () => ({}),
			toJSON() {
				return {};
			},
		},
		plugins: { length: 0 },
		mimeTypes: { length: 0 },
		sendBeacon: () => true,
	};
	sandbox.window = sandbox;
	sandbox.self = sandbox;
	sandbox.frames = sandbox;
	sandbox.parent = { postMessage: () => {} };
	sandbox.top = sandbox;
	sandbox.outerWidth = 1024;
	sandbox.outerHeight = 576;
	sandbox.innerWidth = 1024;
	sandbox.innerHeight = 576;
	sandbox.devicePixelRatio = 2;
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
		'MutationObserver',
		'IntersectionObserver',
		'ResizeObserver',
		'EventTarget',
	])
		sandbox[C] = () => {};
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
		throw new Error();
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
	});
	sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
	sandbox.addEventListener = () => {};
	sandbox.removeEventListener = () => {};
	for (const k of [
		'Error',
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
	])
		sandbox[k] = globalThis[k];
	const ctx = vm.createContext(sandbox);
	if (withInline) {
		try {
			new vm.Script(
				readFileSync('/tmp/build-nvidia-bundles/hcaptcha/inline.js', 'utf8'),
			).runInContext(ctx, { timeout: 10_000 });
		} catch {}
		await new Promise((r) => setTimeout(r, 1500));
	}
	new vm.Script(readFileSync('/tmp/hsw.js', 'utf8')).runInContext(ctx);
	await sandbox.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
	getRandomCount = 0; // reset post-bootstrap

	const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
	const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
	const out = await sandbox.hsw(jwt, opts);
	console.log(`${label}: proof=${out.length}, getRandomValues calls=${getRandomCount}`);
}

await test('baseline (hsw alone)', false);
await test('with inline.js loaded first', true);
