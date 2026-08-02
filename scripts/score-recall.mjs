#!/usr/bin/env node
/**
 * score-recall — what a discovery run found, against what the target is known
 * to have.
 *
 * PURPOSE
 *   Captured traffic is a floor: an endpoint that fired provably exists, but
 *   nothing in a capture says what never fired. Every recall number this project
 *   has produced was that floor, reported as though it were a score, which is
 *   why the numbers were not comparable between runs or targets.
 *
 *   This compares a run's derived elimination table against a grader-held key of
 *   what published reverse-engineering work says the target has. That turns
 *   recall into a measurement with a denominator.
 *
 * WHO RUNS IT
 *   The maintainer, after a run — never the agent doing the discovery. The key
 *   names the expected findings, so putting it in front of the thing being
 *   measured destroys the measurement. See AGENTS.md on keeping the answer out
 *   of the exam paper.
 *
 * USAGE
 *   node scripts/score-recall.mjs --target=twitch --run=derived.json
 *   node scripts/discover-probe.mjs --mode=manifest --json > derived.json
 *   node scripts/score-recall.mjs --target=twitch --run=derived.json --json
 *
 * BOUNDS
 *   Reads two files and prints. No network, no browser, no model calls, no
 *   writes. Exits non-zero when recall is below --min (default 0, report only).
 *
 * Importing this module runs nothing — `score` is exported so
 * scripts/__tests__/score-recall.test.mjs drives it over fixtures.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The uniform 4-line argv parser every script in this folder shares. */
export function parseArgs(argv) {
	const flags = {};
	for (const arg of argv) {
		const raw = arg.replace(/^--/, '');
		const eq = raw.indexOf('=');
		if (eq === -1) flags[raw] = true;
		else flags[raw.slice(0, eq)] = raw.slice(eq + 1);
	}
	return {
		target: typeof flags.target === 'string' ? flags.target : null,
		run: typeof flags.run === 'string' ? flags.run : null,
		min: Number(flags.min ?? 0),
		json: flags.json === true,
		help: flags.help === true || flags.h === true,
	};
}

/**
 * Score a run's transports against a key.
 *
 * A transport the run found that the key does not list is reported rather than
 * ignored: the key records what published work happened to document, so a
 * surplus is either a real find the key should gain or a misattributed row.
 * Both are worth a look, and neither should quietly inflate a score.
 */
export function score(key, verdicts) {
	// A manifest is built from primitives the page reached for, so it can never
	// report a verdict about a payload's *shape* — embedded data, an encoded
	// body, markup-over-the-wire, gRPC framing. Scoring those against it made
	// every such row a guaranteed miss: one target's only expected transport was
	// unscoreable, so it could not have scored above zero however good the run.
	// They are reported as unscored rather than counted as failures.
	const all = key.transports ?? [];
	const scorable = all.filter((t) => (t.detectableBy ?? 'observation') === 'observation');
	const unscored = all.filter((t) => (t.detectableBy ?? 'observation') !== 'observation');

	const found = new Set((verdicts ?? []).filter((v) => v.present).map((v) => v.transport));
	const expected = scorable.map((t) => t.transport);

	const hit = expected.filter((t) => found.has(t));
	const missed = scorable.filter((t) => !found.has(t.transport));
	const surplus = [...found].filter((t) => !expected.includes(t)).sort();

	return {
		target: key.target,
		asOf: key.asOf ?? null,
		hit,
		missed,
		unscored,
		surplus,
		recall: expected.length ? hit.length / expected.length : 0,
		// A key is a record of what a source said on a date. A site that migrated
		// makes a stale key report false misses, which is worse than no key.
		staleWarning: key.asOf ?? null,
	};
}

/** Human-readable report. The misses carry their note, since that is the lesson. */
export function render(result) {
	const lines = [`Target: ${result.target}  (key as of ${result.asOf ?? 'unknown'})`, ''];
	for (const t of result.hit) lines.push(`  ✓ ${t}`);
	for (const m of result.missed) {
		lines.push(`  ✗ MISSED  ${m.transport}`);
		if (m.endpoints?.length) lines.push(`             ${m.endpoints.slice(0, 3).join(', ')}`);
		if (m.note) lines.push(`             why it is easy to miss: ${m.note}`);
	}
	if (result.unscored?.length) {
		lines.push('', '  Not scoreable from a manifest — these are payload-shape verdicts:');
		for (const u of result.unscored) {
			lines.push(`    · ${u.transport}${u.note ? ` — ${u.note}` : ''}`);
		}
		lines.push('    Check these against the source scan, not against captured primitives.');
	}
	if (result.surplus.length) {
		lines.push('', `  + beyond the key: ${result.surplus.join(', ')}`);
		lines.push('    Either a real find the key should gain, or a row attributed wrongly.');
	}
	const total = result.hit.length + result.missed.length;
	lines.push(
		'',
		`  ${result.hit.length}/${total} = ${(result.recall * 100).toFixed(0)}%  (scoreable rows only)`,
	);
	if (result.asOf) {
		lines.push('', `  The key is a record of what sources said on ${result.asOf}, not a fact.`);
		lines.push('  Re-verify before treating a miss as a failure of the run.');
	}
	return lines.join('\n');
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || !opts.target || !opts.run) {
		console.log(
			'Usage: node scripts/score-recall.mjs --target=<name> --run=<derived.json> [--json] [--min=0..1]',
		);
		console.log('  <derived.json> is the output of: discover-probe.mjs --mode=manifest --json');
		return opts.help ? 0 : 2;
	}

	const key = JSON.parse(
		readFileSync(resolve(ROOT, `data/answer-keys/${opts.target}.json`), 'utf8'),
	);
	const run = JSON.parse(readFileSync(resolve(opts.run), 'utf8'));
	const verdicts = run.transports ?? run;

	const result = score(key, verdicts);
	console.log(opts.json ? JSON.stringify(result, null, 2) : render(result));
	return result.recall >= opts.min ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(`score-recall failed: ${err?.message ?? err}`);
			process.exit(2);
		});
}
