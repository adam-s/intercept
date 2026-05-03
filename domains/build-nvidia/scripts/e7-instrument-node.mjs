/**
 * E7-D — run the SAME instrumented hsw.js in Node and capture per-function
 * call counts. Diff against /tmp/instrument-chrome.json (captured live).
 *
 * Usage:
 *   node domains/build-nvidia/scripts/e7-instrument-node.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const HSW_PATH = '/tmp/hsw.js';
const CHROME_DUMP = '/tmp/instrument-chrome.json';

// Mirror of instrumentHswSource() from src/hsw-instrument.ts
function instrumentHswSource(src) {
	let counter = 0;
	const patched = src.replace(/function\s*(?:[\w$]+)?\s*\(([^)]*)\)\s*\{/g, (match) => {
		counter++;
		return `${match}window.__bn_hi&&window.__bn_hi(${counter});`;
	});
	return { patched, counter };
}

const src = readFileSync(HSW_PATH, 'utf8');
const { patched, counter } = instrumentHswSource(src);
console.log(`instrumented ${counter} functions`);

const win = new Window({
	url: 'https://newassets.hcaptcha.com/captcha/v1/c6e277da86802178b920b24f7bd79dd5d0c81e0d/static/hcaptcha.html#frame=challenge&id=0gtest&host=build.nvidia.com&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=0c6a1e45-75d7-43cc-b836-a0c9d886b8ee&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com',
});
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');

// Install counter
win.eval(`
const _counts = {};
const _seq = [];
window.__bn_hi = function(n) {
  _counts[n] = (_counts[n] || 0) + 1;
  if (_seq.length < 50000) _seq.push(n);
};
window.__bn_hi_dump = function() { return { counts: _counts, sequence: _seq, sequenceLen: _seq.length }; };
window.__bn_hi_reset = function() { for (const k in _counts) delete _counts[k]; _seq.length = 0; };
`);

// Eval instrumented hsw.js
win.eval(patched);
console.log(`hsw type: ${typeof win.hsw}`);

await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
// Reset counts after bootstrap so we only capture proof
win.eval('window.__bn_hi_reset()');

const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof = await win.hsw(jwt, opts);
console.log(`proof: ${proof.length}`);

const dump = win.eval('window.__bn_hi_dump()');
const counts = dump.counts;
console.log(`unique fns called during proof: ${Object.keys(counts).length}`);
console.log(`sequence length: ${dump.sequenceLen}`);

writeFileSync('/tmp/instrument-node.json', JSON.stringify({ counts, sequenceLen: dump.sequenceLen }));

// Diff against Chrome
let chrome;
try { chrome = JSON.parse(readFileSync(CHROME_DUMP, 'utf8')); } catch { console.log('no chrome dump to diff'); process.exit(0); }
const cCounts = chrome.counts || {};

console.log('\n=== DIFF: Chrome vs Node ===');
console.log(`Chrome unique fns: ${Object.keys(cCounts).length}, sequenceLen: ${chrome.sequenceLen}`);
console.log(`Node   unique fns: ${Object.keys(counts).length}, sequenceLen: ${dump.sequenceLen}`);

// Functions Chrome called but Node didn't
const onlyChrome = Object.keys(cCounts).filter(k => !(k in counts)).map(Number).sort((a,b) => a-b);
const onlyNode = Object.keys(counts).filter(k => !(k in cCounts)).map(Number).sort((a,b) => a-b);
console.log(`\nfns called in Chrome but NOT Node (${onlyChrome.length}): ${onlyChrome.slice(0, 30).join(',')}${onlyChrome.length > 30 ? '...' : ''}`);
console.log(`fns called in Node but NOT Chrome (${onlyNode.length}): ${onlyNode.slice(0, 30).join(',')}${onlyNode.length > 30 ? '...' : ''}`);

// Functions where call counts differ massively
console.log('\nbiggest count differences (Chrome - Node):');
const allFns = new Set([...Object.keys(cCounts), ...Object.keys(counts)]);
const diffs = [];
for (const fn of allFns) {
	const c = cCounts[fn] || 0;
	const n = counts[fn] || 0;
	const delta = c - n;
	if (Math.abs(delta) > 100) diffs.push({ fn: Number(fn), c, n, delta });
}
diffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
for (const d of diffs.slice(0, 20)) {
	console.log(`  fn#${d.fn}: chrome=${d.c}, node=${d.n}, delta=${d.delta}`);
}

await win.close();
