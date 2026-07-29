#!/usr/bin/env node
/**
 * snapshot — report-only visual capture of dashboard pages.
 *
 * PURPOSE
 *   Capture named page states across named viewports for human review, plus a
 *   machine-readable summary. This tool REPORTS; it never asserts and it never
 *   exits non-zero on what it sees. The asserting tier over routes is
 *   route-spec.mjs; there is deliberately no assertion here, because "does this
 *   look right" is a judgment a script should not make.
 *
 *   Replaces the earlier one-shot screenshot helper: same capability, plus
 *   multiple states, multiple viewports, one artifact directory per run, and a
 *   summary JSON that a later diff can consume.
 *
 * USAGE
 *   node scripts/snapshot.mjs                                  # every state, every viewport
 *   node scripts/snapshot.mjs --label=before-refactor          # name the artifact dir
 *   node scripts/snapshot.mjs --scenarios=home,detail          # a subset of states
 *   node scripts/snapshot.mjs --viewports=mobile,desktop
 *   node scripts/snapshot.mjs --states=./my-states.json        # supply your own
 *   node scripts/snapshot.mjs --path=/dashboard                # one ad-hoc page
 *   node scripts/snapshot.mjs --headless=false                 # watch it run
 *
 * STATES
 *   `--path=/x` captures that single page. `--states=FILE` reads a JSON array
 *   of { name, path, waitFor? }, where `waitFor` is a CSS selector the page
 *   must show before the shot is taken. With neither, DEFAULT_STATES below
 *   applies. `--path` wins over `--states`.
 *
 * BOUNDS
 *   At most --budget captures (default 24 = 8 states × 3 viewports), one page
 *   load each, --timeout ms per navigation (default 30000), and a hard
 *   --wall-clock ceiling (default 300s). Output goes only to
 *   .snapshots/<label>/ (gitignored): one PNG per state×viewport plus
 *   summary.json. No model calls, no assertions, nothing written elsewhere.
 *
 *   A run that captures everything it set out to capture keeps its artifacts —
 *   they are the product. A run that fails to reach the app leaves what it got
 *   and exits 1, because an empty snapshot directory silently reads as "nothing
 *   changed."
 *
 * Importing this module runs nothing — the pure helpers are exported so
 * scripts/__tests__/snapshot.test.mjs drives them with no browser.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Viewports worth checking: the three the layout actually branches on. */
export const VIEWPORTS = {
	mobile: { width: 390, height: 844 },
	tablet: { width: 834, height: 1112 },
	desktop: { width: 1440, height: 900 },
};

/** Pages captured when no --states file is supplied. */
export const DEFAULT_STATES = [{ name: 'home', path: '/' }];

// ─── Arg parsing ─────────────────────────────────────────────────────

/** The uniform 4-line argv parser every script in this folder shares. */
export function parseArgs(argv) {
	const flags = {};
	for (const arg of argv) {
		const raw = arg.replace(/^--/, '');
		// Split on the FIRST '=' only: a value can contain more of them
		// (--url=/api?page=2), and splitting on all of them silently truncates it.
		const eq = raw.indexOf('=');
		if (eq === -1) flags[raw] = true;
		else flags[raw.slice(0, eq)] = raw.slice(eq + 1);
	}
	return {
		label: typeof flags.label === 'string' ? flags.label : 'latest',
		scenarios: typeof flags.scenarios === 'string' ? flags.scenarios.split(',') : null,
		viewports: typeof flags.viewports === 'string' ? flags.viewports.split(',') : null,
		states: typeof flags.states === 'string' ? flags.states : null,
		path: typeof flags.path === 'string' ? flags.path : null,
		headless: flags.headless !== 'false',
		budget: Number(flags.budget ?? 24),
		port: Number(flags.port ?? 3000),
		timeout: Number(flags.timeout ?? 30_000),
		wallClock: Number(flags['wall-clock'] ?? 300) * 1000,
		help: flags.help === true || flags.h === true,
	};
}

/**
 * The states this run will capture, given the flags. Pure.
 *
 * `--path` wins over `--states` so an ad-hoc single-page capture never has to
 * author a file.
 */
export function resolveStates(opts, readStatesFile) {
	if (opts.path) return [{ name: 'page', path: opts.path }];
	if (opts.states) return readStatesFile(opts.states);
	return DEFAULT_STATES;
}

/** Resolve --scenarios / --viewports selections against what exists. Pure. */
export function selectWork(states, viewportNames, selection) {
	const chosenStates = selection.scenarios
		? states.filter((s) => selection.scenarios.includes(s.name))
		: states;
	const chosenViewports = selection.viewports
		? viewportNames.filter((v) => selection.viewports.includes(v))
		: viewportNames;

	const unknownStates = (selection.scenarios ?? []).filter(
		(n) => !states.some((s) => s.name === n),
	);
	const unknownViewports = (selection.viewports ?? []).filter((n) => !viewportNames.includes(n));

	const work = [];
	for (const state of chosenStates) {
		for (const viewport of chosenViewports) work.push({ state, viewport });
	}
	return { work, unknownStates, unknownViewports };
}

/** Artifact filename for one capture. Stable, so runs diff cleanly. */
export function shotName(stateName, viewportName) {
	return `${stateName}--${viewportName}.png`;
}

// ─── Runner ──────────────────────────────────────────────────────────

const HELP = `snapshot — report-only visual capture across states and viewports

  node scripts/snapshot.mjs [--label=NAME] [--scenarios=a,b] [--viewports=a,b]
                            [--states=FILE] [--path=/x] [--headless=false] [--budget=N]
                            [--port=N] [--timeout=MS] [--wall-clock=SECONDS]

Read the header docblock in this file for the bounds this run will respect.`;

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(HELP);
		return 0;
	}

	const started = Date.now();
	const states = resolveStates(opts, (file) =>
		JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')),
	);

	const { work, unknownStates, unknownViewports } = selectWork(
		states,
		Object.keys(VIEWPORTS),
		opts,
	);
	for (const n of unknownStates) console.log(`⊘ Unknown state "${n}" — skipped.`);
	for (const n of unknownViewports) console.log(`⊘ Unknown viewport "${n}" — skipped.`);

	if (work.length === 0) {
		console.error('✗ Nothing selected to capture.');
		return 1;
	}

	const outDir = resolve(ROOT, '.snapshots', opts.label);
	mkdirSync(outDir, { recursive: true });

	const { chromium } = await import('patchright');
	const browser = await chromium.launch({ headless: opts.headless });
	const captures = [];
	let budgetStopped = 0;

	try {
		for (const [i, { state, viewport }] of work.entries()) {
			if (i >= opts.budget) {
				budgetStopped = work.length - i;
				break;
			}
			if (Date.now() - started > opts.wallClock) {
				console.error(`✗ Wall-clock ceiling (${opts.wallClock / 1000}s) reached — stopping.`);
				budgetStopped = work.length - i;
				break;
			}

			const t0 = Date.now();
			const page = await browser.newPage({ viewport: VIEWPORTS[viewport] });
			const file = shotName(state.name, viewport);
			try {
				await page.goto(`http://localhost:${opts.port}${state.path}`, {
					waitUntil: 'networkidle',
					timeout: opts.timeout,
				});
				if (state.waitFor) {
					await page.waitForSelector(state.waitFor, { timeout: opts.timeout });
				}
				await page.screenshot({ path: resolve(outDir, file), type: 'png', fullPage: true });
				captures.push({ state: state.name, viewport, file, ms: Date.now() - t0 });
				console.log(`✓ ${state.name} @ ${viewport} → ${file} (${Date.now() - t0}ms)`);
			} catch (err) {
				captures.push({ state: state.name, viewport, file: null, error: err.message });
				console.log(`✗ ${state.name} @ ${viewport}: ${err.message}`);
			} finally {
				await page.close();
			}
		}
	} finally {
		await browser.close();
	}

	const summary = {
		label: opts.label,
		startedAt: new Date(started).toISOString(),
		durationMs: Date.now() - started,
		port: opts.port,
		viewports: VIEWPORTS,
		captures,
	};
	writeFileSync(resolve(outDir, 'summary.json'), `${JSON.stringify(summary, null, '\t')}\n`);

	// A silent cap reads as full coverage. Say what was dropped.
	if (budgetStopped > 0) {
		console.log(`\n⊘ ${budgetStopped} capture(s) not taken — budget or wall-clock reached.`);
	}

	const failures = captures.filter((c) => c.error);
	const secs = ((Date.now() - started) / 1000).toFixed(1);
	console.log(
		`\n${captures.length - failures.length}/${captures.length} captured in ${secs}s → .snapshots/${opts.label}/`,
	);

	// Report-only about what the pages LOOK like; still honest about not
	// having reached them at all.
	if (failures.length === captures.length) {
		console.error('✗ Every capture failed — is the web app running?');
		return 1;
	}
	return 0;
}

// Importing runs nothing; a unit test drives the exported helpers directly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
