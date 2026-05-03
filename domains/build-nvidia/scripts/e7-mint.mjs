/**
 * E7 — pure-Node hCaptcha mint, end-to-end. NO browser.
 *
 * Flow:
 *   1. Load proof JS (`hsw.js`) into a Node vm with minimal polyfills.
 *   2. Bootstrap call.
 *   3. Decrypt a captured fresh response — this stashes the next spec
 *      inside hsw's internal state.
 *   4. Encrypt a fresh fingerprint payload.
 *   5. POST [next_spec_str, encrypted_bytes] msgpacked to
 *      api.hcaptcha.com/getcaptcha/<sitekey>.
 *   6. Decrypt the server's response.
 *   7. Print the new token.
 *
 * If the server accepts our request and returns a P1_… token, E7 is solved.
 *
 * Run:  node domains/build-nvidia/scripts/e7-mint.mjs
 */

import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';
import { decode, encode } from '@msgpack/msgpack';
import msgpackLite from 'msgpack-lite';

const HSW_PATH = '/tmp/hsw.js';
const FRESH_RESP_PATH = '/tmp/fresh-resp.bin';
const SITEKEY = '0c6a1e45-75d7-43cc-b836-a0c9d886b8ee';
const HOST = 'build.nvidia.com';

// ─── sandbox (same as e7-isolate.mjs) ──────────────────────────────────
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
sandbox.document = {
	createElement: () => ({
		setAttribute() {},
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
sandbox.Navigator = function Navigator() {};
sandbox.Document = function Document() {};
sandbox.Screen = function Screen() {};
sandbox.Performance = function Performance() {};
sandbox.SubtleCrypto = function SubtleCrypto() {};
sandbox.RTCRtpReceiver = function RTCRtpReceiver() {};
sandbox.RTCPeerConnection = function RTCPeerConnection() {};
sandbox.Worker = function Worker() {
	throw new Error('Worker called');
};
sandbox.fetch = function fetch() {
	throw new Error('fetch called');
};
sandbox.URL = URL;
sandbox.URLSearchParams = URLSearchParams;
sandbox.Blob = function Blob() {};
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
sandbox.Buffer = Buffer;

const ctx = vm.createContext(sandbox);
new vm.Script(readFileSync(HSW_PATH, 'utf8'), { filename: 'hsw.js' }).runInContext(ctx, {
	timeout: 10_000,
});
console.log(`hsw loaded: ${typeof sandbox.hsw}`);

async function awaitOrTimeout(p, ms, label) {
	return Promise.race([
		Promise.resolve(p),
		new Promise((_r, rj) => setTimeout(() => rj(new Error(`${label} timeout ${ms}ms`)), ms)),
	]);
}

async function main() {
	// 1. Bootstrap (init the proof function — sets internal state)
	const t0 = Date.now();
	const bootRes = await awaitOrTimeout(
		sandbox.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.'),
		5000,
		'bootstrap',
	);
	console.log(`bootstrap (${Date.now() - t0}ms): ${typeof bootRes} len=${bootRes?.length || 0}`);

	// 2. Decrypt a captured fresh response — gives us the next spec.req JWT
	const respBytes = readFileSync(FRESH_RESP_PATH);
	const t1 = Date.now();
	const decBytes = await awaitOrTimeout(sandbox.hsw(0, new Uint8Array(respBytes)), 5000, 'decrypt');
	const decObj = decode(decBytes);
	console.log(`decrypt (${Date.now() - t1}ms): keys=${Object.keys(decObj).join(',')}`);
	const challengeJwt = decObj.c.req;
	const nextSpecStr = JSON.stringify(decObj.c);
	console.log(`  challenge JWT: ${challengeJwt.slice(0, 60)}…`);

	// 3. Compute proof: hsw(<JWT>) returns the proof STRING that goes
	//    into payload.n. This is THE expensive call — runs the bytecode VM.
	const t2 = Date.now();
	const proof = await awaitOrTimeout(sandbox.hsw(challengeJwt), 30_000, 'proof');
	console.log(`proof (${Date.now() - t2}ms): ${typeof proof} len=${proof?.length || 0}`);

	// 4. Build the real fingerprint payload — shape from observed live hsw input.
	const payload = {
		v: 'c6e277da86802178b920b24f7bd79dd5d0c81e0d',
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
			topLevel: { st: Date.now() - 6000, sc: { availWidth: 2560, availHeight: 1400 } },
			session: [],
			widgetList: ['e7w'],
			widgetId: 'e7w',
			href: 'https://build.nvidia.com/openai/gpt-oss-20b',
			prev: { escaped: false, passed: false, expiredChallenge: false, expiredResponse: false },
		}),
		pdc: '',
		pem: JSON.stringify({}),
		n: proof, // ← the load-bearing proof string
		e: {},
	};
	const fpBytes = encode(payload);
	console.log(`payload msgpack: ${fpBytes.byteLength} bytes`);
	const t3 = Date.now();
	const encBytes = await awaitOrTimeout(sandbox.hsw(1, fpBytes), 15000, 'encrypt');
	console.log(`encrypt (${Date.now() - t3}ms): ${encBytes.byteLength} bytes`);

	// 4. Build request body: msgpack-LITE [spec_string, encrypted_bytes].
	// msgpack-lite encodes Uint8Array as ExtType code 18 (non-standard);
	// the hCaptcha server requires this exact wire format.
	const body = msgpackLite.encode([nextSpecStr, encBytes]);
	console.log(`request body: ${body.byteLength} bytes (msgpack-lite ext18)`);

	// 5. POST to hCaptcha
	const url = `https://api.hcaptcha.com/getcaptcha/${SITEKEY}`;
	const tPost = Date.now();
	// Read browser's hcaptcha cookies (set by the prior browser-driven mint).
	const cookieRes = await fetch(
		'http://localhost:3001/api/build-nvidia/debug/cookies?domain=hcaptcha.com',
	);
	const cookieJson = await cookieRes.json();
	const cookieHeader = cookieJson.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
	console.log(`cookies forwarded: ${cookieHeader}`);

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			accept: 'application/json, application/octet-stream',
			'content-type': 'application/octet-stream',
			origin: 'https://newassets.hcaptcha.com',
			referer: 'https://newassets.hcaptcha.com/',
			cookie: cookieHeader,
		},
		body,
	});
	console.log(`POST (${Date.now() - tPost}ms): status=${res.status}`);
	const respBuf = new Uint8Array(await res.arrayBuffer());
	console.log(`response: ${respBuf.byteLength} bytes`);

	// 6. Decode/decrypt response
	console.log(`\n=== response (${respBuf.byteLength} bytes) ===`);
	console.log('first 64 hex:', Buffer.from(respBuf).slice(0, 64).toString('hex'));
	// Try msgpack-lite plain (error responses are typically plaintext)
	try {
		const plain = msgpackLite.decode(respBuf);
		console.log('msgpack-lite decoded plaintext:', JSON.stringify(plain, null, 2).slice(0, 800));
	} catch (e) {
		console.log('msgpack-lite plain decode failed:', e.message);
	}
	// Try as JSON
	try {
		const j = JSON.parse(Buffer.from(respBuf).toString('utf8'));
		console.log('json:', JSON.stringify(j, null, 2).slice(0, 500));
	} catch {
		// Try as encrypted via hsw
		try {
			const out = await awaitOrTimeout(sandbox.hsw(0, respBuf), 5000, 'decrypt-response');
			if (out instanceof Uint8Array) {
				const obj = decode(out);
				console.log('\n=== DECRYPTED ===');
				console.log(
					JSON.stringify(
						obj,
						(_k, v) =>
							typeof v === 'string' && v.length > 80 ? `${v.slice(0, 60)}…[${v.length}]` : v,
						2,
					),
				);
				if (obj?.generated_pass_UUID) {
					console.log('\n*** TOKEN MINTED FROM PURE NODE: ***');
					console.log(obj.generated_pass_UUID);
				}
			} else {
				console.log('hsw decrypt returned non-Uint8Array:', out);
			}
		} catch (e) {
			console.log('hsw decrypt failed:', e?.message || e);
		}
	}
}

main().catch((e) => {
	console.error('FAIL:', e);
	process.exit(1);
});
