/**
 * E7 — pure-Node mint, FRESH session (no captured browser state).
 *
 * Goal: discover the right call sequence by experimenting with different
 * input shapes to hsw(). We have no captured I/O for the FIRST getcaptcha
 * call (the browser already did one before our tap attached), so we have
 * to figure out the cold-start protocol from the bundle source + experiment.
 */

import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';
import { decode, encode } from '@msgpack/msgpack';
import msgpackLite from 'msgpack-lite';

const HSW_PATH = '/tmp/hsw.js';
const SITEKEY = '0c6a1e45-75d7-43cc-b836-a0c9d886b8ee';
const HOST = 'build.nvidia.com';

// ─── sandbox bootstrap (identical to other scripts) ────────────────────
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
for (const Ctor of [
	'Navigator',
	'Document',
	'Screen',
	'Performance',
	'SubtleCrypto',
	'RTCRtpReceiver',
	'RTCPeerConnection',
])
	sandbox[Ctor] = () => {};
sandbox.Worker = function Worker() {
	throw new Error('Worker called');
};
sandbox.fetch = function fetch() {
	throw new Error('fetch called');
};
sandbox.URL = URL;
sandbox.URLSearchParams = URLSearchParams;
sandbox.Blob = function Blob() {};
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
	// Step 0: persistent cookie jar (server tracks session via Set-Cookie hmt_id)
	const cookieJar = new Map();
	const fetchWithCookies = async (url, opts = {}) => {
		const _u = new URL(url);
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

	// Step 1: Bootstrap hsw
	console.log('\n=== Step 1: bootstrap ===');
	const boot = await awaitOrTimeout(
		sandbox.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.'),
		5000,
		'bootstrap',
	);
	console.log(`bootstrap returned ${typeof boot} len=${boot?.length || 0}`);

	// Step 2: GET checksiteconfig — server initialises session, returns initial spec
	console.log('\n=== Step 2: GET checksiteconfig ===');
	const cscUrl = `https://api.hcaptcha.com/checksiteconfig?v=c6e277da86802178b920b24f7bd79dd5d0c81e0d&host=${HOST}&sitekey=${SITEKEY}&sc=1&swa=1&spst=1`;
	const r1 = await fetchWithCookies(cscUrl, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'text/plain',
			origin: 'https://newassets.hcaptcha.com',
			referer: 'https://newassets.hcaptcha.com/',
		},
	});
	console.log(`status=${r1.status}, cookies after: ${[...cookieJar.keys()].join(',')}`);
	const j1 = await r1.json();
	console.log(`features: ${JSON.stringify(j1.features)}`);
	const firstSpec = j1.c;
	console.log(`spec.req[:80]: ${firstSpec?.req?.slice(0, 80)}…`);

	if (!firstSpec) {
		console.log('No spec — bailing.');
		return;
	}

	// Step 3 removed — we now know hsw(JWT) is the proof call (Step 4).

	// Step 4: Compute proof for the fresh spec by passing the JWT to hsw.
	console.log('\n=== Step 4: compute proof for fresh spec ===');
	// Load real captured opts (vm_data) from prior /debug/hsw-tap dump.
	const capturedOpts = JSON.parse(readFileSync('/tmp/hsw-proof-opts.json', 'utf8'));
	const tProof = Date.now();
	const proofOpts = {
		href: 'https://build.nvidia.com/openai/gpt-oss-20b',
		ardata: null,
		vm_data: capturedOpts.vm_data, // ← was null; now real fingerprint state
		uj_data: capturedOpts.uj_data, // typically null
		errors: capturedOpts.errors || [],
	};
	const proof = await awaitOrTimeout(sandbox.hsw(firstSpec.req, proofOpts), 30_000, 'proof');
	console.log(
		`proof (${Date.now() - tProof}ms): len=${proof?.length || 0}, vm_data ${proofOpts.vm_data ? 'PRESENT' : 'null'}`,
	);

	// Step 5: build payload with proof embedded, encrypt, POST
	console.log('\n=== Step 5: encrypted second call (with proof) ===');
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
		pd: JSON.stringify({ s: Date.now(), n: 0, p: 0, gcs: 100 }),
		pdc: JSON.stringify({ s: Date.now(), n: 0, p: 0, gcs: 100 }),
		pem: JSON.stringify({ csc: 100, csch: 'api.hcaptcha.com', cscrt: 0, cscft: 100 }),
		n: proof, // a.n = s.solved = the proof string
		e: null,
	};
	const fpBytes = encode(payload);
	console.log(`payload msgpack: ${fpBytes.byteLength} bytes`);
	const enc = await awaitOrTimeout(sandbox.hsw(1, fpBytes), 15000, 'encrypt');
	console.log(`encrypted: ${enc.byteLength} bytes`);
	const body2 = msgpackLite.encode([JSON.stringify(firstSpec), enc]);
	const r2 = await fetchWithCookies(`https://api.hcaptcha.com/getcaptcha/${SITEKEY}`, {
		method: 'POST',
		headers: {
			accept: 'application/json, application/octet-stream',
			'content-type': 'application/octet-stream',
			origin: 'https://newassets.hcaptcha.com',
			referer: 'https://newassets.hcaptcha.com/',
		},
		body: body2,
	});
	console.log(`POST 2 status=${r2.status}`);
	const buf2 = new Uint8Array(await r2.arrayBuffer());
	console.log(`resp: ${buf2.byteLength} bytes`);
	console.log(`first 64 hex: ${Buffer.from(buf2).slice(0, 64).toString('hex')}`);
	// Try every decode strategy
	try {
		console.log('json:', JSON.parse(Buffer.from(buf2).toString('utf8')));
		return;
	} catch {}
	try {
		const dec = await awaitOrTimeout(sandbox.hsw(0, buf2), 5000, 'dec2');
		if (dec instanceof Uint8Array) {
			const obj = decode(dec);
			console.log('\n=== STEP-4 DECRYPTED ===');
			console.log(
				JSON.stringify(
					obj,
					(_k, v) =>
						typeof v === 'string' && v.length > 80 ? `${v.slice(0, 60)}…[${v.length}]` : v,
					2,
				),
			);
			if (obj?.generated_pass_UUID)
				console.log(`\n*** PURE-NODE TOKEN: ***\n${obj.generated_pass_UUID}`);
		} else console.log('hsw returned:', dec);
	} catch (e) {
		console.log('decrypt2 failed:', e.message);
	}
}

main().catch((e) => {
	console.error('FAIL:', e);
	process.exit(1);
});
