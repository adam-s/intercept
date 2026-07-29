#!/usr/bin/env node
/**
 * waf-probe — compare what each browser driver looks like to bot detection.
 *
 * PURPOSE
 *   docs/BROWSER-DRIVERS.md claims Camoufox presents a cleaner automation
 *   fingerprint than Patchright. That claim arrived from a sibling repo, and a
 *   pinned lesson is re-probeable: this script re-measures it locally so the
 *   table rests on evidence from this machine rather than inheritance.
 *
 *   Two different things get measured, and conflating them would overstate the
 *   result:
 *
 *   1. **Fingerprint surface** — the automation tells a detector reads:
 *      `navigator.webdriver`, the headless UA marker, the WebGL vendor string
 *      (SwiftShader is the classic headless giveaway), plugin and language
 *      arrays, and whether CDP artifacts are visible to page script. This is
 *      the variable that decides a challenge outcome, and it is directly
 *      observable without touching anyone's production WAF.
 *
 *   2. **Turnstile widget execution** — whether the real
 *      `challenges.cloudflare.com` script loads, runs, and issues a token on
 *      Cloudflare's own public demo. Note the demo's sitekey is a documented
 *      *always-passes* test key, so a token there proves the integration works
 *      end to end. It does NOT prove anything about detection — only the
 *      fingerprint surface above speaks to that.
 *
 * USAGE
 *   node scripts/waf-probe.mjs                       # both drivers, both probes
 *   node scripts/waf-probe.mjs --drivers=camoufox
 *   node scripts/waf-probe.mjs --scenarios=fingerprint
 *   node scripts/waf-probe.mjs --headless=false --json
 *
 * SCOPE
 *   Targets are limited to purpose-built measurement endpoints and Cloudflare's
 *   own demo — pages that exist to be probed. This is a comparison of our two
 *   drivers, not a tool for getting through a third party's protection, and
 *   the target list is deliberately fixed rather than accepting a --url.
 *
 * BOUNDS
 *   At most one page load per driver per scenario (4 loads at defaults), a
 *   --timeout of 45000ms each, and a hard --wall-clock ceiling of 240s. No
 *   retries, no interaction with a challenge, no token replay anywhere. Writes
 *   only to .waf-probe/<label>/ (gitignored). No model calls.
 *
 * Importing this module runs nothing — the pure helpers are exported so
 * scripts/__tests__/waf-probe.test.mjs drives them with no browser.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Fixed target list. Deliberately not configurable — see SCOPE. */
export const SCENARIOS = {
	fingerprint: {
		url: 'https://bot.sannysoft.com/',
		description: 'Automation tells readable by any page script',
	},
	turnstile: {
		url: 'https://demo.turnstile.workers.dev/',
		description: "Cloudflare's own Turnstile demo (always-passes test sitekey)",
	},
	// Live vendor-protected origins. One GET each, no interaction, no solving —
	// the measurement is only "did the origin answer, or did its edge answer."
	// Vendor homepages run their own product, which makes them the fairest
	// available public check that is not somebody's unrelated business.
	cloudflare: {
		url: 'https://nowsecure.nl/',
		description: 'Cloudflare managed challenge (long-standing public test page)',
		live: true,
	},
	datadome: {
		url: 'https://datadome.co/',
		description: 'DataDome, running its own product',
		live: true,
	},
	kasada: {
		url: 'https://www.kasada.io/',
		description: 'Kasada, running its own product',
		live: true,
	},
};

/**
 * Read a live origin's response into a verdict. Pure.
 *
 * "Challenged" means the edge answered instead of the origin. The signals are
 * the interstitial's own markers, so an ordinary slow page is not misread as a
 * block.
 */
export function readLiveResult(observed) {
	const title = (observed.title ?? '').toLowerCase();
	const body = (observed.bodySample ?? '').toLowerCase();
	const challengeMarkers = [
		'just a moment',
		'checking your browser',
		'attention required',
		'verify you are human',
		'enable javascript and cookies',
		'access denied',
		'blocked',
		'pardon our interruption',
	];
	const hit = challengeMarkers.find((m) => title.includes(m) || body.includes(m));
	if (hit) return { verdict: 'challenged', detail: `interstitial marker "${hit}"` };
	if (observed.status >= 400) {
		return { verdict: 'blocked', detail: `HTTP ${observed.status}` };
	}
	// A short page is not evidence of a block: a pass/fail indicator page is
	// minimal by design, and an earlier length threshold here misread
	// nowsecure.nl's success page as suspicious. Absence of an interstitial
	// marker plus a 2xx from the origin is the pass.
	if ((observed.textLength ?? 0) === 0) {
		return { verdict: 'empty', detail: 'no text rendered' };
	}
	return { verdict: 'passed', detail: `HTTP ${observed.status}, ${observed.textLength} chars` };
}

// ─── Arg parsing ─────────────────────────────────────────────────────

/** The uniform 4-line argv parser every script in this folder shares. */
export function parseArgs(argv) {
	const flags = {};
	for (const arg of argv) {
		const raw = arg.replace(/^--/, '');
		// Split on the FIRST '=' only: a value can contain more of them.
		const eq = raw.indexOf('=');
		if (eq === -1) flags[raw] = true;
		else flags[raw.slice(0, eq)] = raw.slice(eq + 1);
	}
	return {
		drivers:
			typeof flags.drivers === 'string' ? flags.drivers.split(',') : ['patchright', 'camoufox'],
		scenarios:
			typeof flags.scenarios === 'string' ? flags.scenarios.split(',') : Object.keys(SCENARIOS),
		label: typeof flags.label === 'string' ? flags.label : 'latest',
		headless: flags.headless !== 'false',
		timeout: Number(flags.timeout ?? 45_000),
		wallClock: Number(flags['wall-clock'] ?? 240) * 1000,
		json: flags.json === true,
		help: flags.help === true || flags.h === true,
	};
}

// ─── Pure scoring ────────────────────────────────────────────────────

/**
 * Score a fingerprint reading. Lower is less automated-looking.
 *
 * Each entry is a tell a detector actually reads. The score is a count of
 * tells present, not a probability — it ranks two stacks against each other
 * and says nothing about whether either passes a given WAF.
 */
export function scoreFingerprint(fp) {
	const tells = [];
	if (fp.webdriver === true) tells.push('navigator.webdriver is true');
	if (/headless/i.test(fp.userAgent ?? '')) tells.push('UA advertises headless');
	if (/swiftshader|llvmpipe|mesa offscreen/i.test(fp.webglRenderer ?? '')) {
		tells.push(`software WebGL renderer (${fp.webglRenderer})`);
	}
	if ((fp.pluginCount ?? 0) === 0) tells.push('no plugins');
	if ((fp.languages?.length ?? 0) === 0) tells.push('empty navigator.languages');
	if (fp.cdcArtifacts?.length) tells.push(`CDP artifacts on window: ${fp.cdcArtifacts.join(', ')}`);
	if (fp.permissionsMismatch === true) tells.push('Notification permission mismatch');
	return { tells, score: tells.length };
}

/** Read a Turnstile result into a verdict. Pure. */
export function readTurnstileResult(observed) {
	if (!observed.apiScriptLoaded) {
		return {
			verdict: 'script-blocked',
			detail: 'challenges.cloudflare.com/turnstile/v0/api.js never loaded',
		};
	}
	if (!observed.widgetRendered) {
		return { verdict: 'widget-absent', detail: 'api.js loaded but no widget iframe rendered' };
	}
	if (observed.token) {
		return {
			verdict: 'token-issued',
			detail: `token length ${observed.token.length}, prefix "${observed.token.slice(0, 12)}"`,
		};
	}
	return { verdict: 'no-token', detail: 'widget rendered but issued no token within the wait' };
}

// ─── In-page readings ────────────────────────────────────────────────

/** Runs in the page. Reads the tells a detector would read. */
function readFingerprint() {
	const gl = (() => {
		try {
			const canvas = document.createElement('canvas');
			const ctx = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
			if (!ctx) return { vendor: 'no-webgl', renderer: 'no-webgl' };
			const ext = ctx.getExtension('WEBGL_debug_renderer_info');
			return {
				vendor: ext ? ctx.getParameter(ext.UNMASKED_VENDOR_WEBGL) : 'masked',
				renderer: ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'masked',
			};
		} catch (err) {
			return { vendor: 'error', renderer: String(err) };
		}
	})();

	// Chromium automation leaves recognizable properties on window/document.
	const cdcArtifacts = [...Object.keys(window), ...Object.keys(document)].filter((k) =>
		/^\$?cdc_|^\$chrome_asyncScriptInfo|^__webdriver|^__selenium|^__nightmare/.test(k),
	);

	return {
		userAgent: navigator.userAgent,
		platform: navigator.platform,
		webdriver: navigator.webdriver,
		pluginCount: navigator.plugins?.length ?? 0,
		languages: Array.from(navigator.languages ?? []),
		hardwareConcurrency: navigator.hardwareConcurrency,
		deviceMemory: navigator.deviceMemory ?? null,
		webglVendor: gl.vendor,
		webglRenderer: gl.renderer,
		cdcArtifacts,
	};
}

/** Runs in the page. Reads whether Turnstile loaded, rendered, and issued a token. */
function readTurnstile() {
	const apiScriptLoaded = Array.from(document.scripts).some((s) =>
		s.src.includes('challenges.cloudflare.com'),
	);
	// Turnstile renders into a shadow root, so a document-level iframe query
	// misses it entirely — the widget container gaining a child is the signal
	// that survives that, and the response field is the authoritative one.
	const container = document.querySelector('.cf-turnstile, [data-sitekey]');
	const widgetRendered = Boolean(
		document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
			(container && (container.children.length > 0 || container.shadowRoot)),
	);
	const field = document.querySelector('input[name="cf-turnstile-response"]');
	return {
		apiScriptLoaded,
		widgetRendered,
		token: field && field.value ? field.value : null,
	};
}

/** Runs in the page. Reads enough to tell an origin response from an interstitial. */
function readLive() {
	return {
		title: document.title,
		textLength: (document.body?.innerText ?? '').length,
		bodySample: (document.body?.innerText ?? '').slice(0, 400),
	};
}

// ─── Runner ──────────────────────────────────────────────────────────

const HELP = `waf-probe — compare each driver's automation fingerprint

  node scripts/waf-probe.mjs [--drivers=a,b] [--scenarios=a,b] [--label=NAME]
                             [--headless=false] [--timeout=MS] [--json]

Read the header docblock in this file for scope and bounds.`;

async function probeDriver(kind, scenarios, opts) {
	const { requireDriver } = await import('../packages/browser/src/driver/index.ts');
	const driver = await requireDriver(kind);

	// Camoufox refuses true headless by design; honor its rule rather than
	// forcing a mode that reliably fails.
	const headless = kind === 'camoufox' ? false : opts.headless;
	const session = await driver.launch({ headless });
	const results = {};

	try {
		for (const name of scenarios) {
			const scenario = SCENARIOS[name];
			if (!scenario) {
				results[name] = { error: `unknown scenario "${name}"` };
				continue;
			}
			const page = await session.newPage();
			try {
				const response = await page.goto(scenario.url, {
					waitUntil: 'load',
					timeout: opts.timeout,
				});
				const status = response?.status?.() ?? 0;
				// Turnstile needs a moment to execute and populate its field.
				await new Promise((r) => setTimeout(r, name === 'turnstile' ? 8000 : 2500));

				if (name === 'fingerprint') {
					const fp = await page.evaluate(readFingerprint);
					results[name] = { ...fp, ...scoreFingerprint(fp) };
				} else if (scenario.live) {
					const observed = await page.evaluate(readLive);
					observed.status = status;
					results[name] = { ...observed, ...readLiveResult(observed) };
				} else {
					const observed = await page.evaluate(readTurnstile);
					results[name] = { ...observed, ...readTurnstileResult(observed) };
				}
			} catch (err) {
				results[name] = { error: err.message };
			} finally {
				await page.close().catch(() => {});
			}
		}
	} finally {
		await session.close().catch(() => {});
	}
	return results;
}

function report(all) {
	for (const [kind, scenarios] of Object.entries(all)) {
		console.log(`\n═══ ${kind} ═══`);
		const fp = scenarios.fingerprint;
		if (fp?.error) {
			console.log(`  fingerprint: ✗ ${fp.error}`);
		} else if (fp) {
			console.log(`  UA:            ${fp.userAgent}`);
			console.log(`  platform:      ${fp.platform}   cores: ${fp.hardwareConcurrency}`);
			console.log(`  webdriver:     ${fp.webdriver}`);
			console.log(`  WebGL:         ${fp.webglVendor} / ${fp.webglRenderer}`);
			console.log(`  plugins:       ${fp.pluginCount}   languages: ${fp.languages.join(',')}`);
			console.log(`  automation tells: ${fp.score}`);
			for (const t of fp.tells) console.log(`      • ${t}`);
		}

		for (const [name, scenario] of Object.entries(SCENARIOS)) {
			if (name === 'fingerprint') continue;
			const r = scenarios[name];
			if (!r) continue;
			const label = `${name}:`.padEnd(15);
			console.log(`  ${label}${r.error ? `✗ ${r.error}` : `${r.verdict} — ${r.detail}`}`);
			void scenario;
		}
	}

	const scored = Object.entries(all)
		.filter(([, s]) => typeof s.fingerprint?.score === 'number')
		.sort((a, b) => a[1].fingerprint.score - b[1].fingerprint.score);
	if (scored.length > 1) {
		console.log('\n─── ranking (fewer tells first) ───');
		for (const [kind, s] of scored) console.log(`  ${s.fingerprint.score}  ${kind}`);
		console.log('\nTells are what a detector reads. The Turnstile line uses an always-passes');
		console.log('test sitekey, so it shows the integration works — not that detection was beaten.');
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(HELP);
		return 0;
	}

	const started = Date.now();
	const outDir = resolve(ROOT, '.waf-probe', opts.label);
	mkdirSync(outDir, { recursive: true });

	const all = {};
	for (const kind of opts.drivers) {
		if (Date.now() - started > opts.wallClock) {
			console.error(`\n✗ Wall-clock ceiling (${opts.wallClock / 1000}s) reached — stopping.`);
			break;
		}
		try {
			all[kind] = await probeDriver(kind, opts.scenarios, opts);
		} catch (err) {
			all[kind] = { error: err.message };
			console.error(`✗ ${kind}: ${err.message}`);
		}
	}

	if (opts.json) console.log(JSON.stringify(all, null, '\t'));
	else report(all);

	writeFileSync(
		resolve(outDir, 'report.json'),
		`${JSON.stringify({ startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, results: all }, null, '\t')}\n`,
	);
	console.log(`\nArtifacts: .waf-probe/${opts.label}/report.json`);
	return 0;
}

// Importing runs nothing; a unit test drives the exported scoring directly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
