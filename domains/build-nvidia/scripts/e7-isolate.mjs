/**
 * E7 isolation — load the hCaptcha proof JS in a Node `vm` sandbox and
 * invoke its encrypt/decrypt entry points on captured I/O.
 *
 * Run with:  node domains/build-nvidia/scripts/e7-isolate.mjs
 */

import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';

const HSW_PATH = '/tmp/hsw.js';
const _REQ_PATH = '/tmp/hcap-xhr-req.bin';
const RESP_PATH = '/tmp/hcap-xhr-200.bin';

// ─── minimal browser-like sandbox ─────────────────────────────────────
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
sandbox.Uint8Array = Uint8Array;
sandbox.Uint16Array = Uint16Array;
sandbox.Uint32Array = Uint32Array;
sandbox.Int8Array = Int8Array;
sandbox.Int16Array = Int16Array;
sandbox.Int32Array = Int32Array;
sandbox.Float32Array = Float32Array;
sandbox.Float64Array = Float64Array;
sandbox.ArrayBuffer = ArrayBuffer;
sandbox.DataView = DataView;
sandbox.Map = Map;
sandbox.Set = Set;
sandbox.WeakMap = WeakMap;
sandbox.WeakSet = WeakSet;

// Polyfill DOM-ish bits the proof JS likely fingerprints on
const stubFn = (name) => () => {
	throw new Error(`stub ${name} called`);
};
sandbox.document = {
	createElement: (tag) => ({
		tagName: String(tag).toUpperCase(),
		setAttribute() {},
		getAttribute() {
			return null;
		},
		appendChild() {},
		style: {},
	}),
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
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
	language: 'en-US',
	languages: ['en-US', 'en'],
	platform: 'MacIntel',
	hardwareConcurrency: 16,
	deviceMemory: 16,
	maxTouchPoints: 0,
	cookieEnabled: true,
	webdriver: false,
	connection: { effectiveType: '4g', downlink: 10, rtt: 50 },
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
};
sandbox.window = sandbox; // self-reference
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
// Constructors that the proof JS may stringify-check
sandbox.Navigator = function Navigator() {};
sandbox.Document = function Document() {};
sandbox.Screen = function Screen() {};
sandbox.Performance = function Performance() {};
sandbox.SubtleCrypto = function SubtleCrypto() {};
sandbox.RTCRtpReceiver = function RTCRtpReceiver() {};
sandbox.RTCPeerConnection = function RTCPeerConnection() {};
// Worker/fetch — stub so the proof JS detects them as present (fingerprint)
// but never calls them in the encrypt/decrypt path.
sandbox.Worker = function Worker() {
	throw new Error('Worker called');
};
sandbox.fetch = stubFn('fetch');
sandbox.URL = URL;
sandbox.URLSearchParams = URLSearchParams;
sandbox.Blob = stubFn('Blob');
sandbox.Error = Error;
sandbox.JSON = JSON;
sandbox.Math = Math;
sandbox.Object = Object;
sandbox.Array = Array;
sandbox.String = String;
sandbox.Number = Number;
sandbox.Boolean = Boolean;
sandbox.Date = Date;
sandbox.RegExp = RegExp;
sandbox.Symbol = Symbol;
sandbox.Reflect = Reflect;
sandbox.Proxy = Proxy;
sandbox.Function = Function;
sandbox.Buffer = Buffer; // not in browsers but harmless

const ctx = vm.createContext(sandbox);

// Load and execute the proof JS
const hswSrc = readFileSync(HSW_PATH, 'utf8');
console.log(`hsw.js: ${hswSrc.length} bytes`);

let loadErr = null;
try {
	new vm.Script(hswSrc, { filename: 'hsw.js' }).runInContext(ctx, { timeout: 10_000 });
} catch (e) {
	loadErr = e;
}
console.log(`load error: ${loadErr ? String(loadErr.message).slice(0, 300) : '<none>'}`);
console.log(`window.hsw type: ${typeof sandbox.hsw}`);
console.log(
	`globals on window after load (sample):`,
	Object.keys(sandbox).filter((k) => /hsw|hcap|cap|widget|exec|native/i.test(k)),
);

if (typeof sandbox.hsw !== 'function') {
	console.log('Bailing — hsw not exposed.');
	process.exit(1);
}

// Try the bootstrap call first.
async function main() {
	console.log('\n=== bootstrap call ===');
	try {
		const bootRes = sandbox.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
		const settled = await Promise.race([
			Promise.resolve(bootRes),
			new Promise((_r, rj) => setTimeout(() => rj(new Error('boot timeout 5s')), 5000)),
		]).catch((e) => e);
		console.log(
			`bootstrap returned:`,
			typeof settled,
			settled instanceof Error ? settled.message : String(settled).slice(0, 200),
		);
	} catch (e) {
		console.log('bootstrap THROW:', String(e?.message || e).slice(0, 300));
	}

	// Try decrypt: hsw(0, captured_response_bytes) and see if we get plausible plaintext.
	console.log('\n=== decrypt call hsw(0, captured_response) ===');
	const respBytes = readFileSync(RESP_PATH);
	const respUint8 = new Uint8Array(respBytes);
	try {
		const r = sandbox.hsw(0, respUint8);
		const out = await Promise.race([
			Promise.resolve(r),
			new Promise((_r, rj) => setTimeout(() => rj(new Error('decrypt timeout 10s')), 10000)),
		]).catch((e) => e);
		if (out instanceof Error) {
			console.log('decrypt FAILED:', out.message.slice(0, 300));
		} else if (out instanceof Uint8Array) {
			console.log(`decrypt OK: returned Uint8Array(${out.byteLength}).`);
			// Use the @msgpack/msgpack package to decode
			const { decode } = await import('@msgpack/msgpack');
			try {
				const obj = decode(out);
				console.log('msgpack-decoded response top-level keys:', Object.keys(obj || {}));
				console.log(
					'msgpack JSON (first 1500):',
					JSON.stringify(
						obj,
						(_k, v) =>
							typeof v === 'string' && v.length > 200 ? `${v.slice(0, 80)}…[${v.length}]` : v,
						2,
					).slice(0, 1500),
				);
			} catch (e) {
				const ascii = Buffer.from(out)
					.toString('utf8')
					.replace(/[^\x20-\x7e]/g, '.');
				console.log('msgpack decode failed:', e.message, 'ascii preview:', ascii.slice(0, 200));
			}
		} else {
			console.log(`decrypt returned other:`, typeof out, String(out).slice(0, 200));
		}
	} catch (e) {
		console.log('decrypt THROW:', String(e?.message || e).slice(0, 300));
	}
}

// ─── E7-B: encrypt test ──────────────────────────────────────────────
async function encryptTest() {
	console.log('\n=== encrypt call hsw(1, msgpack(fingerprint)) ===');
	const { encode, decode } = await import('@msgpack/msgpack');
	// Build a minimal payload modeled after `getTaskData`'s `c` (with c.c stripped).
	const payload = {
		v: 'c6e277da86802178b920b24f7bd79dd5d0c81e0d', // bundle hash (from inline.js)
		sitekey: '0c6a1e45-75d7-43cc-b836-a0c9d886b8ee',
		host: 'build.nvidia.com',
		hl: 'en',
		motionData: JSON.stringify({
			st: Date.now() - 5000,
			mm: [
				[100, 200, 100],
				[110, 210, 200],
			], // [x, y, t-offset] tuples
			mm_mp: 0.5,
			md: [[100, 200, 50]],
			md_mp: 0.4,
			mu: [[110, 210, 250]],
			mu_mp: 0.3,
			v: 1,
			topLevel: { st: Date.now() - 6000, sc: { availWidth: 2560, availHeight: 1400 } },
			session: [],
			widgetList: ['0vmeo1jcy60g'],
			widgetId: '0vmeo1jcy60g',
			href: 'https://build.nvidia.com/openai/gpt-oss-20b',
			prev: { escaped: false, passed: false, expiredChallenge: false, expiredResponse: false },
		}),
	};
	const bytes = encode(payload);
	console.log(`payload msgpack size: ${bytes.byteLength} bytes`);
	try {
		const r = sandbox.hsw(1, bytes);
		const out = await Promise.race([
			Promise.resolve(r),
			new Promise((_r, rj) => setTimeout(() => rj(new Error('encrypt timeout 15s')), 15000)),
		]).catch((e) => e);
		if (out instanceof Error) {
			console.log('encrypt FAILED:', out.message.slice(0, 300));
		} else if (out instanceof Uint8Array) {
			console.log(
				`encrypt OK: returned Uint8Array(${out.byteLength}). first 64 hex:`,
				Buffer.from(out).slice(0, 64).toString('hex'),
			);
			// Try to round-trip: decrypt our own encrypted payload back
			console.log('\n=== round-trip: decrypt our own encryption ===');
			const back = await Promise.race([
				Promise.resolve(sandbox.hsw(0, out)),
				new Promise((_r, rj) => setTimeout(() => rj(new Error('roundtrip timeout 5s')), 5000)),
			]).catch((e) => e);
			if (back instanceof Uint8Array) {
				try {
					const obj = decode(back);
					console.log('round-trip decoded:', JSON.stringify(obj, null, 2).slice(0, 600));
				} catch (e) {
					console.log('round-trip decode err:', e.message);
				}
			} else {
				console.log('round-trip non-Uint8Array:', String(back).slice(0, 200));
			}
		} else {
			console.log('encrypt returned:', typeof out, String(out).slice(0, 200));
		}
	} catch (e) {
		console.log('encrypt THROW:', String(e?.message || e).slice(0, 300));
	}
}

main()
	.then(() => encryptTest())
	.catch((e) => {
		console.error('main fail:', e);
		process.exit(1);
	});
