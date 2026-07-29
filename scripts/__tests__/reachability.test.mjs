/**
 * Every capability has a caller.
 *
 * AGENTS.md states that shipped means reachable: a capability no workflow can
 * invoke does not exist yet, however finished the code is. Stating it did not
 * prevent it. The capture layer was built, tested, and committed with no entry
 * point; the interaction sweep was then built, tested, and committed with no
 * caller in the very pass that fixed the first one. Both passed every test and
 * read as done, because each part in isolation was.
 *
 * That is what this checks. An exported function in a capability module must be
 * called from somewhere outside its own module and outside a test — an app, a
 * script, a domain, or another package. A test-only caller is the specific
 * disguise this failure wears, so it does not count.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Modules whose exports are capabilities rather than internal helpers. */
const CAPABILITY_DIRS = ['packages/browser/src/driver'];

/** Where a real caller may live. Tests and the module's own directory do not count. */
const CALLER_ROOTS = ['apps', 'scripts', 'domains', 'packages'];

/**
 * Exports that legitimately have no caller yet, each with the reason. An entry
 * here is a deliberate, reviewable decision — which is the point. An empty
 * reason is not accepted, so adding one costs a sentence of justification.
 */
const ACCEPTED = {
	camoufoxDriver: 'Selected by name through getDriver, never imported directly.',
	patchrightDriver: 'Selected by name through getDriver, never imported directly.',
	startTrafficCapture: 'Invoked through the DriverSession interface, not by name.',
};

const walk = (rel) => {
	const abs = resolve(ROOT, rel);
	let out = [];
	for (const e of readdirSync(abs, { withFileTypes: true })) {
		if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__') continue;
		const child = `${rel}/${e.name}`;
		if (e.isDirectory()) out = out.concat(walk(child));
		else if (/\.(ts|mjs|js)$/.test(e.name)) out.push(child);
	}
	return out;
};

/** Exported function names in a module, ignoring types and interfaces. */
function exportedFunctions(src) {
	return [
		...src.matchAll(/^export (?:async )?function (\w+)/gm),
		...src.matchAll(/^export const (\w+) = (?:async )?\(/gm),
	].map((m) => m[1]);
}

const capabilityFiles = CAPABILITY_DIRS.flatMap((d) => walk(d)).filter(
	(f) => !f.endsWith('index.ts'),
);

const callerFiles = CALLER_ROOTS.flatMap((r) => {
	try {
		statSync(resolve(ROOT, r));
	} catch {
		return [];
	}
	return walk(r);
}).filter((f) => !f.includes('__tests__') && !f.includes('.test.'));

describe('every capability has a caller', () => {
	it('found capability modules and caller files, so this cannot pass vacuously', () => {
		expect(capabilityFiles.length).toBeGreaterThan(3);
		expect(callerFiles.length).toBeGreaterThan(20);
	});

	const cases = capabilityFiles.flatMap((file) => {
		const src = readFileSync(resolve(ROOT, file), 'utf8');
		return exportedFunctions(src).map((name) => ({ file, name }));
	});

	it('found exported capabilities to check', () => {
		expect(cases.length).toBeGreaterThan(5);
	});

	// A pure helper exported so a test can drive it directly is fine — it has a
	// caller, just an internal one. The failure this catches is narrower and
	// worse: an export reachable from nothing but its own tests, which passes CI
	// while doing nothing for anybody.
	it.each(
		cases.map((c) => [c.name, c.file]),
	)('%s is reachable from real code (%s)', (name, file) => {
		if (ACCEPTED[name]) {
			expect(ACCEPTED[name].length, `${name} needs a real reason`).toBeGreaterThan(20);
			return;
		}
		const pattern = new RegExp(`\\b${name}\\b`, 'g');

		const own = readFileSync(resolve(ROOT, file), 'utf8');
		// Its own export line is not a use of it.
		const internalUses = (own.match(pattern) ?? []).length - 1;

		// A sibling module in the same directory is a real caller. Excluding the
		// whole directory would have called `captureDecision` dead while
		// traffic-capture.ts imports and uses it on every response.
		const external = callerFiles.filter(
			(f) => f !== file && pattern.test(readFileSync(resolve(ROOT, f), 'utf8')),
		);

		expect(
			internalUses > 0 || external.length > 0,
			`${name} is exported from ${file} and called nowhere but its tests. ` +
				'Wire it to a workflow, delete it, or record it in ACCEPTED with the reason.',
		).toBe(true);
	});
});
