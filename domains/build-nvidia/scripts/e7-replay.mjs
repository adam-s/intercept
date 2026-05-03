/**
 * E7 — feed the EXACT captured browser-side hsw inputs into our Node hsw
 * and POST. This is the deterministic check: if the proof is exactly
 * what the browser produced and the encryption is exactly what the
 * browser produced, the server should accept it.
 *
 * The catch: we have a CAPTURE WINDOW problem. The browser captured a
 * msgpack input that already embedded a proof for a SPECIFIC spec. By
 * the time we replay, the server has already consumed that spec.
 *
 * So this test really verifies: when we replay byte-for-byte the
 * captured (spec, encrypted_body) pair, what does the server say? If it
 * says `success:false, error-codes:["spec already used"]` then we know
 * the protocol is right, just the spec is consumed. If it says
 * `client-fail` or 415 etc., we have a deeper issue.
 */

import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';
import { decode } from '@msgpack/msgpack';
import msgpackLite from 'msgpack-lite';

const HSW_PATH = '/tmp/hsw.js';
const SITEKEY = '0c6a1e45-75d7-43cc-b836-a0c9d886b8ee';
const HSW_IN_MODE1 = '/tmp/hsw-in-1-mode1.bin';
const HSW_OUT_MODE1 = '/tmp/hsw-out-1-mode1.bin';

// minimal sandbox (truncated for brevity)
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
sandbox.Worker = () => {
	throw new Error('Worker');
};
sandbox.fetch = () => {
	throw new Error('fetch in sandbox');
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
console.log('hsw loaded:', typeof sandbox.hsw);

async function awaitOrTimeout(p, ms, label) {
	return Promise.race([
		Promise.resolve(p),
		new Promise((_r, rj) => setTimeout(() => rj(new Error(`${label} timeout`)), ms)),
	]);
}

async function main() {
	// 1. Bootstrap
	const boot = await awaitOrTimeout(
		sandbox.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.'),
		5000,
		'boot',
	);
	console.log('bootstrap:', boot.length);

	// 2. Read the EXACT captured msgpack input the browser fed to hsw(1,...)
	const captured = readFileSync(HSW_IN_MODE1);
	console.log(`captured input: ${captured.length} bytes`);
	const decoded = msgpackLite.decode(captured);
	console.log('keys:', Object.keys(decoded));
	console.log('  proof n length:', decoded.n?.length);

	// 3. The proof inside `n` was computed by the browser for SOME spec.
	//    Decode the proof header to find which spec it was for. The proof
	//    string format starts with a base64-of-spec-JSON: "<b64>.<b64>.<b64>".
	const proofParts = decoded.n.split('.');
	console.log(
		'  proof parts:',
		proofParts.length,
		'lengths:',
		proofParts.map((p) => p.length),
	);
	try {
		const proofHeader = JSON.parse(Buffer.from(proofParts[0], 'base64').toString('utf8'));
		console.log('  proof header (first part):', JSON.stringify(proofHeader).slice(0, 200));
	} catch {}

	// 4. Reproduce: feed our hsw the SAME spec via the proof JWT.
	//    The challenge JWT lives in `n` somewhere — but more directly, we
	//    DON'T have the full chain state. Just try replaying the captured
	//    encrypted blob as-is.
	const capturedEncBuf = readFileSync(HSW_OUT_MODE1);
	// Buffer must be normalised to Uint8Array so msgpack-lite encodes it as
	// ext18 (Uint8Array convention) rather than as bin8/16/32 — the server
	// rejects bin-encoded item [1] with 415 Unsupported Media Type.
	const capturedEncrypted = new Uint8Array(
		capturedEncBuf.buffer,
		capturedEncBuf.byteOffset,
		capturedEncBuf.byteLength,
	);
	console.log(
		`\nreplaying captured encrypted blob (${capturedEncrypted.length} bytes, type=${capturedEncrypted.constructor.name})`,
	);
	// We need the corresponding plaintext spec — extract from the captured request.
	const capturedReq = readFileSync('/tmp/fresh-req.bin');
	const reqArr = msgpackLite.decode(capturedReq);
	const specStr = reqArr[0];
	console.log(`spec str (${specStr.length} chars): ${specStr.slice(0, 100)}…`);

	const body = msgpackLite.encode([specStr, capturedEncrypted]);
	console.log(`POST body: ${body.length} bytes`);

	// Forward cookies
	const cookieRes = await fetch(
		'http://localhost:3001/api/build-nvidia/debug/cookies?domain=hcaptcha.com',
	);
	const cookieJson = await cookieRes.json();
	const cookieHeader = cookieJson.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

	const res = await fetch(`https://api.hcaptcha.com/getcaptcha/${SITEKEY}`, {
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
	console.log(`status=${res.status}`);
	const buf = new Uint8Array(await res.arrayBuffer());
	console.log(
		`resp ${buf.length} bytes, first 32 hex:`,
		Buffer.from(buf).slice(0, 32).toString('hex'),
	);
	try {
		const j = JSON.parse(Buffer.from(buf).toString('utf8'));
		console.log('json:', JSON.stringify(j, null, 2).slice(0, 600));
		return;
	} catch {}
	try {
		const dec = await awaitOrTimeout(sandbox.hsw(0, buf), 5000, 'dec');
		if (dec instanceof Uint8Array) {
			const obj = decode(dec);
			console.log('\n=== DECRYPTED ===');
			console.log(
				JSON.stringify(
					obj,
					(_k, v) =>
						typeof v === 'string' && v.length > 80 ? v.slice(0, 60) + '…[' + v.length + ']' : v,
					2,
				),
			);
			if (obj?.generated_pass_UUID)
				console.log('\n*** PURE-NODE TOKEN ***\n', obj.generated_pass_UUID);
		}
	} catch (e) {
		console.log('decrypt err:', e.message);
	}
}

main().catch((e) => {
	console.error('fail:', e);
	process.exit(1);
});
