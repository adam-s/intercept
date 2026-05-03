/**
 * E7-D-5: Replay the EXACT (JWT, opts) the live iframe passed to hsw,
 * compare proof bytes to what the iframe got back. If equal → our Node
 * hsw is byte-deterministic given identical inputs and the only thing
 * we were missing was vm_data.
 */

import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';

const HSW_PATH = '/tmp/hsw.js';

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
	width: 2560,
	height: 1440,
	availWidth: 2560,
	availHeight: 1400,
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
sandbox.outerWidth = 2560;
sandbox.outerHeight = 1400;
sandbox.innerWidth = 1280;
sandbox.innerHeight = 720;
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
new vm.Script(readFileSync(HSW_PATH, 'utf8')).runInContext(ctx);

const jwt = readFileSync('/tmp/hsw-proof-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/hsw-proof-opts.json', 'utf8'));
console.log(`jwt len: ${jwt.length}, opts.vm_data len: ${opts.vm_data?.length}`);

await sandbox.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');

// Test 1: WITHOUT vm_data
const proof1 = await sandbox.hsw(jwt, {
	href: opts.href,
	ardata: null,
	vm_data: null,
	uj_data: null,
});
console.log(`\nproof WITHOUT vm_data: len=${proof1.length}`);

// Test 2: WITH vm_data captured from live iframe
const proof2 = await sandbox.hsw(jwt, {
	href: opts.href,
	ardata: null,
	vm_data: opts.vm_data,
	uj_data: null,
});
console.log(`proof WITH vm_data:    len=${proof2.length}`);

// Compare to what the live iframe actually returned (we recorded out.length)
console.log(`\nlive iframe proof length: 19952 (captured)`);
console.log(`our proof matches live size? ${proof2.length === 19952}`);

// Print first few chars to compare
console.log(`\nproof2[0:120]: ${proof2.slice(0, 120)}`);
console.log(`(would compare to live proof if we had it saved)`);
