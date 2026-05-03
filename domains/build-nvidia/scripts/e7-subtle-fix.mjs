import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';

async function test(label, customizeCrypto) {
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
	customizeCrypto(sandbox);
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
	sandbox.document = {
		createElement: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
		querySelector: () => null,
		querySelectorAll: () => [],
		createEvent: () => ({ initEvent() {}, preventDefault() {} }),
		referrer: '',
		location: { href: 'https://newassets.hcaptcha.com/' },
		documentElement: { lang: 'en' },
		getElementById: () => null,
		body: null,
	};
	sandbox.location = { href: 'https://newassets.hcaptcha.com/' };
	sandbox.screen = {
		width: 1024,
		height: 576,
		availWidth: 1024,
		availHeight: 576,
		colorDepth: 24,
		pixelDepth: 24,
		orientation: { type: 'landscape-primary', angle: 0 },
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
	};
	sandbox.window = sandbox;
	sandbox.self = sandbox;
	sandbox.frames = sandbox;
	sandbox.parent = sandbox;
	sandbox.top = sandbox;
	sandbox.outerWidth = 1024;
	sandbox.outerHeight = 576;
	sandbox.innerWidth = 1024;
	sandbox.innerHeight = 576;
	sandbox.devicePixelRatio = 2;
	sandbox.Intl = Intl;
	sandbox.clientInformation = sandbox.navigator;
	for (const C of [
		'Navigator',
		'Document',
		'Screen',
		'Performance',
		'SubtleCrypto',
		'RTCRtpReceiver',
		'RTCPeerConnection',
	])
		sandbox[C] = () => {};
	sandbox.Worker = () => {
		throw new Error();
	};
	sandbox.fetch = () => {
		throw new Error();
	};
	sandbox.URL = URL;
	sandbox.URLSearchParams = URLSearchParams;
	sandbox.Blob = () => {};
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
	new vm.Script(readFileSync('/tmp/hsw.js', 'utf8')).runInContext(ctx);
	await sandbox.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
	const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
	const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
	const out = await sandbox.hsw(jwt, opts);
	console.log(`${label}: proof=${out.length}`);
}

await test('baseline (raw webcrypto)', (s) => {
	s.crypto = webcrypto;
});

// Wrap subtle to convert returned ArrayBuffers to the vm-context's ArrayBuffer
await test('subtle that returns vm-context ArrayBuffer', (s) => {
	const VmArrayBuffer = s.ArrayBuffer; // vm-context ArrayBuffer
	const subtleWrap = {};
	for (const k of [
		'encrypt',
		'decrypt',
		'sign',
		'verify',
		'digest',
		'generateKey',
		'deriveKey',
		'deriveBits',
		'importKey',
		'exportKey',
		'wrapKey',
		'unwrapKey',
	]) {
		subtleWrap[k] = async (...args) => {
			const result = await webcrypto.subtle[k](...args);
			// Convert outer ArrayBuffer to vm-context ArrayBuffer
			if (result instanceof ArrayBuffer) {
				const vmAb = new VmArrayBuffer(result.byteLength);
				new Uint8Array(vmAb).set(new Uint8Array(result));
				return vmAb;
			}
			return result;
		};
	}
	s.crypto = {
		subtle: subtleWrap,
		getRandomValues: (buf) => webcrypto.getRandomValues(buf),
		randomUUID: () => webcrypto.randomUUID(),
	};
});

// Same idea but use sync conversion via Buffer
await test('subtle wrapped with Buffer-convert', (s) => {
	const subtleWrap = {};
	for (const k of [
		'encrypt',
		'decrypt',
		'sign',
		'verify',
		'digest',
		'generateKey',
		'deriveKey',
		'deriveBits',
		'importKey',
		'exportKey',
		'wrapKey',
		'unwrapKey',
	]) {
		subtleWrap[k] = async (...args) => {
			const result = await webcrypto.subtle[k](...args);
			if (result && result.constructor?.name === 'ArrayBuffer') {
				// Re-create as vm-side ArrayBuffer via Uint8Array slice
				const buf = Buffer.from(result);
				const vmAb = new s.ArrayBuffer(buf.length);
				const vmU8 = new s.Uint8Array(vmAb);
				for (let i = 0; i < buf.length; i++) vmU8[i] = buf[i];
				return vmAb;
			}
			return result;
		};
	}
	s.crypto = {
		subtle: subtleWrap,
		getRandomValues: (buf) => webcrypto.getRandomValues(buf),
		randomUUID: () => webcrypto.randomUUID(),
	};
});
