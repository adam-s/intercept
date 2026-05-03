/**
 * E7-D — replay WASM import return values captured from Chrome iframe.
 *
 * Strategy:
 *   1. Read /tmp/wasm-replay/chrome-imports.json (captured live).
 *   2. Build per-(ns,fn) queues of return values.
 *   3. Set up happy-dom + bridge our wrapped WebAssembly.instantiate.
 *   4. When WASM calls import a.X for the Nth time, return captured value
 *      (instead of the real callback).
 *   5. Run hsw bootstrap + proof. Compare proof size to Chrome's 19848.
 *
 * Verifies that "given same imports, same WASM = same output". If our
 * proof grows toward 19848, replay works → we know the gap is in JS
 * callback values, and we can either (a) match each callback's logic
 * deterministically or (b) ship the live-replay approach as is.
 */
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const captured = JSON.parse(readFileSync('/tmp/wasm-replay/chrome-imports.json', 'utf8'));
const importCalls = captured.filter((e) => e.kind === 'import-call');
const exportCalls = captured.filter((e) => e.kind === 'export-enter');
console.log(`captured: ${importCalls.length} import calls, ${exportCalls.length} export calls`);

// Build per-fn queues of return values
const queues = new Map();
for (const e of importCalls) {
	const key = `${e.ns}.${e.fn}`;
	if (!queues.has(key)) queues.set(key, []);
	queues.get(key).push({ args: e.args, result: e.result });
}

const win = new Window({
	url: 'https://newassets.hcaptcha.com/captcha/v1/c6e277da86802178b920b24f7bd79dd5d0c81e0d/static/hcaptcha.html#frame=challenge&id=0gtest&host=build.nvidia.com&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=0c6a1e45-75d7-43cc-b836-a0c9d886b8ee&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com',
});
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');

// Track per-(ns,fn) call counter; on each call, pop next captured value
const callCounters = new Map();
let mismatchCount = 0;
let totalCalls = 0;
const argMismatches = [];
// Also log the first 30 actual calls Node WASM makes
const nodeFirstCalls = [];

// Bridge WebAssembly with replay-imports interception
const origInstantiate = WebAssembly.instantiate;
const replayWA = new Proxy(WebAssembly, {
	get(t, p) {
		if (p === 'instantiate') {
			return function (buffer, importObject) {
				console.log(`WebAssembly.instantiate: bufLen=${buffer?.byteLength}, importNs=${Object.keys(importObject || {})}`);
				const replayedImports = {};
				for (const ns in importObject) {
					replayedImports[ns] = {};
					for (const fn in importObject[ns]) {
						const orig = importObject[ns][fn];
						if (typeof orig !== 'function') {
							replayedImports[ns][fn] = orig;
							continue;
						}
						const key = `${ns}.${fn}`;
						const queue = queues.get(key);
						replayedImports[ns][fn] = function (...args) {
							totalCalls++;
							const n = (callCounters.get(key) || 0) + 1;
							callCounters.set(key, n);
							if (nodeFirstCalls.length < 30) nodeFirstCalls.push({ key, n, args });
							if (!queue || n > queue.length) {
								// Out of captured data — fall back to original
								return orig.apply(this, args);
							}
							const captured = queue[n - 1];
							// Verify args match
							if (JSON.stringify(captured.args) !== JSON.stringify(args)) {
								mismatchCount++;
								if (argMismatches.length < 10) {
									argMismatches.push({ key, n, capturedArgs: captured.args, actualArgs: args });
								}
							}
							// Return captured value
							const r = captured.result;
							if (r.type === 'number') return r.val;
							if (r.type === 'string') return r.val;
							if (r.type === 'undefined') return undefined;
							if (r.type === 'null') return null;
							if (r.type === 'boolean') return Boolean(r.val);
							// Unknown — fall back
							return orig.apply(this, args);
						};
					}
				}
				return origInstantiate(buffer, replayedImports);
			};
		}
		return Reflect.get(t, p);
	},
});
win.WebAssembly = replayWA;

win.eval(readFileSync('/tmp/hsw.js', 'utf8'));
console.log('hsw type:', typeof win.hsw);

console.log('\n--- bootstrap ---');
const boot = await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
console.log(`bootstrap returned: type=${typeof boot} len=${boot?.length}`);
console.log(`  total import calls so far: ${totalCalls}, mismatches: ${mismatchCount}`);

console.log('\n--- proof ---');
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof = await win.hsw(jwt, opts);
console.log(`proof: ${proof?.length} (target: 19848)`);
console.log(`  total import calls: ${totalCalls}, mismatches: ${mismatchCount}`);

if (argMismatches.length > 0) {
	console.log('\nFirst arg mismatches:');
	for (const m of argMismatches.slice(0, 5)) {
		console.log(`  ${m.key} #${m.n}: captured=${JSON.stringify(m.capturedArgs)} actual=${JSON.stringify(m.actualArgs)}`);
	}
}

console.log('\nFirst 30 actual Node WASM import calls:');
for (const c of nodeFirstCalls) {
	console.log(`  ${c.key} #${c.n}: args=${JSON.stringify(c.args)}`);
}

// Show the first 30 Chrome calls in OVERALL ORDER
console.log('\nFirst 30 Chrome WASM import calls (overall order):');
for (const e of importCalls.slice(0, 30)) {
	console.log(`  a.${e.fn}: args=${JSON.stringify(e.args)}`);
}

await win.close();
