/**
 * E7-D-3: Cold-start hCaptcha mint via curl-impersonate (Chrome 145 TLS).
 *
 * Tests whether the JA3/JA4 fingerprint is what gates the encrypted-token
 * issuance path. Same protocol as e7-mint-fresh.mjs but every HTTP call
 * goes through curl-impersonate instead of Bun fetch.
 *
 * Pass criterion: server returns msgpack-encrypted response decryptable by
 * hsw(0, …) yielding {pass:true, generated_pass_UUID:"P1_…"}.
 * Fail criterion: server still returns plaintext JSON {c, success:false}.
 */

import { webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';
import { decode, encode } from '@msgpack/msgpack';
import msgpackLite from 'msgpack-lite';
import { curlImpersonate } from './curl-impersonate.mjs';

const HSW_PATH = '/tmp/hsw.js';
const SITEKEY = '0c6a1e45-75d7-43cc-b836-a0c9d886b8ee';
const HOST = 'build.nvidia.com';

// ─── sandbox ───────────────────────────────────────────────────────────
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
	throw new Error('Worker');
};
sandbox.fetch = () => {
	throw new Error('fetch');
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
new vm.Script(readFileSync(HSW_PATH, 'utf8'), { filename: 'hsw.js' }).runInContext(ctx);
console.log(`hsw loaded: ${typeof sandbox.hsw}`);

async function awaitOrTimeout(p, ms, label) {
	return Promise.race([
		Promise.resolve(p),
		new Promise((_r, rj) => setTimeout(() => rj(new Error(`${label} timeout`)), ms)),
	]);
}

async function main() {
	const cookieJar = path.join(mkdtempSync(path.join(tmpdir(), 'cj-')), 'cookies.txt');
	console.log(`cookie jar: ${cookieJar}`);

	// Step 1: bootstrap hsw
	console.log('\n=== Step 1: bootstrap ===');
	const boot = await awaitOrTimeout(
		sandbox.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.'),
		5000,
		'boot',
	);
	console.log(`bootstrap len=${boot.length}`);

	// Step 2: GET checksiteconfig — via curl-impersonate (Chrome 145 TLS).
	// The browser actually uses POST here per our trace, but with no body.
	console.log('\n=== Step 2: POST checksiteconfig (Chrome 145 TLS) ===');
	const cscUrl = `https://api.hcaptcha.com/checksiteconfig?v=c6e277da86802178b920b24f7bd79dd5d0c81e0d&host=${HOST}&sitekey=${SITEKEY}&sc=1&swa=1&spst=1`;
	// Use XHR Sec-Fetch-* headers (curl-impersonate defaults to navigation
	// values which look wrong for an XHR-from-iframe).
	const xhrHeaders = {
		'sec-fetch-dest': 'empty',
		'sec-fetch-mode': 'cors',
		'sec-fetch-site': 'same-site',
	};
	const r1 = await curlImpersonate(cscUrl, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'text/plain',
			origin: 'https://newassets.hcaptcha.com',
			referer: 'https://newassets.hcaptcha.com/',
			...xhrHeaders,
		},
		cookieJar,
	});
	console.log(`status=${r1.status}, set-cookies=${r1.setCookies.length}`);
	for (const sc of r1.setCookies) console.log(`  ← ${sc.split(';')[0]}`);
	const j1 = JSON.parse(await r1.text());
	console.log(`features: ${JSON.stringify(j1.features)}`);
	const firstSpec = j1.c;
	if (!firstSpec) {
		console.log('No spec — bail');
		return;
	}
	console.log(`spec.req[:80]: ${firstSpec.req.slice(0, 80)}…`);

	// Step 3: compute proof
	console.log('\n=== Step 3: compute proof in Node vm ===');
	const tProof = Date.now();
	const proof = await awaitOrTimeout(
		sandbox.hsw(firstSpec.req, {
			href: 'https://build.nvidia.com/openai/gpt-oss-20b',
			ardata: null,
			vm_data: null,
			uj_data: null,
		}),
		30_000,
		'proof',
	);
	console.log(`proof (${Date.now() - tProof}ms): len=${proof.length}`);

	// Step 4: encrypt fingerprint payload
	console.log('\n=== Step 4: encrypt payload ===');
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
			topLevel: {
				st: Date.now() - 6000,
				sc: { availWidth: 2560, availHeight: 1400, width: 2560, height: 1440 },
			},
			session: [],
			widgetList: ['e7w'],
			widgetId: 'e7w',
			href: 'https://build.nvidia.com/openai/gpt-oss-20b',
			prev: { escaped: false, passed: false, expiredChallenge: false, expiredResponse: false },
		}),
		pdc: '{}',
		pem: '{}',
		n: proof,
		e: null,
	};
	const fpBytes = encode(payload);
	const enc = await awaitOrTimeout(sandbox.hsw(1, fpBytes), 15_000, 'encrypt');
	console.log(`encrypted: ${enc.byteLength} bytes`);
	const body = msgpackLite.encode([JSON.stringify(firstSpec), enc]);
	console.log(`body: ${body.length} bytes`);
	const { writeFileSync } = await import('node:fs');
	writeFileSync('/tmp/e7-tls-body.bin', body);
	console.log(`(saved to /tmp/e7-tls-body.bin)`);

	// Step 5: POST /getcaptcha via curl-impersonate
	console.log('\n=== Step 5: POST /getcaptcha (Chrome 145 TLS) ===');
	const r2 = await curlImpersonate(`https://api.hcaptcha.com/getcaptcha/${SITEKEY}`, {
		method: 'POST',
		headers: {
			accept: 'application/json, application/octet-stream',
			'content-type': 'application/octet-stream',
			origin: 'https://newassets.hcaptcha.com',
			referer: 'https://newassets.hcaptcha.com/',
			...xhrHeaders,
		},
		body: Buffer.from(body),
		cookieJar,
	});
	console.log(
		`status=${r2.status}, content-type=${r2.headers.get('content-type')}, set-cookies=${r2.setCookies.length}`,
	);
	for (const sc of r2.setCookies) console.log(`  ← ${sc.split(';')[0]}`);
	const buf = r2.bytes();
	console.log(
		`response: ${buf.byteLength} bytes, first 32 hex: ${Buffer.from(buf).slice(0, 32).toString('hex')}`,
	);

	// Decode strategies — JSON first, then encrypted via hsw
	let asText = '';
	try {
		asText = Buffer.from(buf).toString('utf8');
	} catch {}
	if (asText.startsWith('{') || asText.startsWith('[')) {
		try {
			const j = JSON.parse(asText);
			console.log('\n--- PLAINTEXT JSON RESPONSE ---');
			console.log(
				JSON.stringify(
					j,
					(_k, v) =>
						typeof v === 'string' && v.length > 80 ? `${v.slice(0, 40)}…[${v.length}]` : v,
					2,
				).slice(0, 800),
			);
			if (j.success === false)
				console.log('\n→ STILL DOWNGRADED. TLS fingerprint did NOT unblock.');
			return;
		} catch {}
	}

	try {
		const dec = await awaitOrTimeout(sandbox.hsw(0, buf), 5000, 'decrypt');
		if (dec instanceof Uint8Array) {
			const obj = decode(dec);
			console.log('\n--- DECRYPTED RESPONSE ---');
			console.log(
				JSON.stringify(
					obj,
					(_k, v) =>
						typeof v === 'string' && v.length > 80 ? `${v.slice(0, 40)}…[${v.length}]` : v,
					2,
				).slice(0, 800),
			);
			if (obj?.generated_pass_UUID) {
				console.log('\n*** PURE-NODE TOKEN MINTED VIA TLS IMPERSONATION ***');
				console.log(`${obj.generated_pass_UUID.slice(0, 80)}…`);
				console.log(`\nlength: ${obj.generated_pass_UUID.length}, expiration: ${obj.expiration}s`);
			}
		} else {
			console.log('hsw decrypt returned:', dec);
		}
	} catch (e) {
		console.log('decrypt failed:', e.message);
	}
}

main().catch((e) => {
	console.error('FAIL:', e);
	process.exit(1);
});
