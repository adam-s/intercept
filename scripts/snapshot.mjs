#!/usr/bin/env node
/**
 * snapshot — report-only visual capture of dashboard pages.
 *
 * PURPOSE
 *   Capture named page states across named viewports for human review, plus a
 *   machine-readable summary. This tool REPORTS on what a page looks like; it
 *   never asserts there, because "does this look right" is a judgment a script
 *   should not make. The asserting tier over routes is route-spec.mjs.
 *
 *   It does assert one thing: that a capture reached its target at all. An
 *   unreachable origin and a bot-wall interstitial both exit 1, because both
 *   mean the page in the PNG is not the page that was asked for — and a
 *   challenge page screenshots cleanly, so nothing else would notice.
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
 *   node scripts/snapshot.mjs --origin=https://example.com --path=/       # a live site
 *   node scripts/snapshot.mjs --origin=https://example.com --profile=example  # persistent
 *
 * PROFILE
 *   `--profile=<name>` runs patchright against a persistent context under
 *   data/browser-profiles/<name>/ instead of a cold launch. Patchright's stealth
 *   patches are built around a real profile, so a site that refuses a cold
 *   headless browser may serve one that carries a profile — the same transport
 *   climb a domain plugin makes. Profiles hold session material: they are
 *   gitignored, and never copied or published.
 *
 * ENGINE
 *   --engine=camoufox goes through the driver seam in packages/browser, which
 *   owns the two settings that are load-bearing and easy to get wrong: camoufox
 *   never runs true headless (it trips protection regardless of engine, so the
 *   driver refuses rather than failing quietly), and it pins the persona OS
 *   whenever a profile persists (a clearance cookie is bound to the user agent
 *   that earned it). Headed means a visible window on macOS. Requires tsx, since
 *   the driver is TypeScript: npx tsx scripts/snapshot.mjs --engine=camoufox
 *
 *   --warm visits the origin root before the deep path, per
 *   .agents/rules/discovery.md. A cold persona deep-linking with no referrer is
 *   one of three signals that get a capture refused; the others are true
 *   headless and an empty profile.
 *
 * WAITING
 *   Navigation settles with --wait-until (default 'load') plus a fixed --settle
 *   delay (default 2000ms) for data the page fetches after first paint.
 *   'networkidle' is deliberately not the default: a page holding a stream open
 *   never reaches it, so every live feed times out instead of being captured.
 *
 *   --full-page=false shoots the viewport only. A page that repaints constantly
 *   never finishes a full-page shot either, for the same underlying reason.
 *
 * ORIGIN
 *   Captures default to `http://localhost:<port>`. `--origin` points the same
 *   machinery at any base URL, which is what the description-driven tuning loop
 *   (.agents/skills/instruction-dashboard-tuning/) needs: its frames come from
 *   real sites, and a frame is only ground truth if it was captured rather than
 *   found. `--origin` wins over `--port`.
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
 *   changed." A blocked run keeps its PNGs too: the interstitial is the evidence
 *   that the site refused, and deleting it would leave only a claim.
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
		origin: typeof flags.origin === 'string' ? flags.origin : null,
		profile: typeof flags.profile === 'string' ? flags.profile : null,
		engine: typeof flags.engine === 'string' ? flags.engine : 'patchright',
		warm: flags.warm === true || flags.warm === 'true',
		waitUntil: typeof flags['wait-until'] === 'string' ? flags['wait-until'] : 'load',
		settle: Number(flags.settle ?? 2000),
		fullPage: flags['full-page'] !== 'false',
		waitFor: typeof flags['wait-for'] === 'string' ? flags['wait-for'] : null,
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
	if (opts.path) return [{ name: 'page', path: opts.path, waitFor: opts.waitFor ?? undefined }];
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

/**
 * Base URL every capture in this run is taken against. Pure.
 *
 * A trailing slash is stripped because every state's `path` already carries a
 * leading one, and `https://x.com/` + `/dashboard` resolves to a doubled slash
 * that some hosts 404 rather than normalise.
 */
export function resolveOrigin(opts) {
	if (opts.origin) return opts.origin.replace(/\/+$/, '');
	return `http://localhost:${opts.port}`;
}

// ─── Engines ─────────────────────────────────────────────────────────

/**
 * Neutral pages a fresh persona visits before the target.
 *
 * A persona is judged on the history it carries, not only on its fingerprint,
 * so a profile whose entire history is one deep link into a protected page
 * reads as purpose-built. These are ordinary destinations that establish a
 * browsing past, ending at a search engine so the target is reached the way a
 * person reaches it.
 */
/**
 * Chromium args that remove the standard automation tells.
 *
 * Lifted from ~/Projects/job-hunter-video/scripts/lib/patchright.mjs, the most
 * recent of several working implementations across these repos.
 * `--disable-blink-features=AutomationControlled` hides `navigator.webdriver`
 * from page script.
 */
export const STEALTH_ARGS = [
	'--disable-infobars',
	'--disable-blink-features=AutomationControlled',
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding',
	'--no-first-run',
	'--no-default-browser-check',
];

/**
 * De-headless a page's User-Agent *and* its `sec-ch-ua` client hints before the
 * first navigation.
 *
 * Headless Chromium leaks `HeadlessChrome` in both places, and they are read
 * independently — rewriting only the UA string leaves the client hints
 * advertising headless, which is a primary Cloudflare and DataDome signal. One
 * CDP `Network.setUserAgentOverride` rewrites both together.
 *
 * No-op when headed, and non-fatal on error: stealth degrades, the capture still
 * runs and the challenge detector still reports honestly.
 */
export async function hardenPage(page) {
	try {
		const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
		if (!ua.includes('Headless')) return;
		const clean = ua.replace('HeadlessChrome', 'Chrome');
		const major = clean.split('Chrome/')[1]?.split('.')[0] ?? '145';
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Network.setUserAgentOverride', {
			userAgent: clean,
			userAgentMetadata: {
				platform: 'macOS',
				platformVersion: '15.0',
				architecture: 'arm',
				model: '',
				mobile: false,
				brands: [
					{ brand: 'Google Chrome', version: major },
					{ brand: 'Chromium', version: major },
					{ brand: 'Not)A;Brand', version: '24' },
				],
			},
		});
	} catch {
		/* non-fatal — stealth degrades, the capture proceeds */
	}
}

export const NEUTRAL_WARM = [
	'https://news.ycombinator.com/',
	'https://en.wikipedia.org/wiki/Web_browser',
	'https://www.google.com/',
];

/**
 * The full warm chain for a capture: neutral history, then the origin's own
 * root, so the deep path is finally reached with a referrer and cookies set.
 *
 * `.agents/rules/discovery.md` states the last hop as a rule — connect to the
 * homepage first, never a deep link. The neutral hops in front of it are what a
 * *fresh* persona additionally needs, because it has no past of its own. Pure,
 * so a test drives it.
 */
export function warmChainFor(origin, neutral = NEUTRAL_WARM) {
	try {
		return [...neutral, new URL(origin).origin];
	} catch {
		return [...neutral];
	}
}

// ─── Challenge detection ─────────────────────────────────────────────

/**
 * Visible-text ceiling under which a marker means a block. Reddit's own wall
 * carries ~140 characters; a real listing page runs to many thousands.
 */
export const CHALLENGE_TEXT_CEILING = 2000;

/**
 * Phrases that only appear on a bot-wall interstitial, never on the content
 * page it replaced. Matched against title + visible text, lowercased.
 */
const RENDERED_CHALLENGE_MARKERS = [
	{ vendor: 'generic-network-block', match: /blocked by network security/ },
	{ vendor: 'cloudflare', match: /checking your browser before accessing/ },
	{ vendor: 'cloudflare', match: /enable javascript and cookies to continue/ },
	{ vendor: 'cloudflare', match: /attention required!/ },
	{ vendor: 'cloudflare', match: /sorry, you have been blocked/ },
	{ vendor: 'generic-waf', match: /this website is using a security service to protect itself/ },
	{ vendor: 'generic-waf', match: /verify(ing)? (that )?you are (a )?human/ },
	{ vendor: 'generic-waf', match: /prove your humanity/ },
	{ vendor: 'generic-waf', match: /complete the challenge/ },
	{ vendor: 'generic-waf', match: /you'?re a real person/ },
	{ vendor: 'generic-waf', match: /are you a robot/ },
	{ vendor: 'generic-waf', match: /press (&|and) hold/ },
	{ vendor: 'generic-waf', match: /access to this page has been denied/ },
	{ vendor: 'generic-waf', match: /you don't have permission to access/ },
	{ vendor: 'google', match: /unusual traffic from your computer network/ },
];

/**
 * Captcha widgets, identified by the iframe origin they mount.
 *
 * This is the signal that generalizes. Phrase markers are derived from walls
 * already seen and are English-only, so they miss the next wording and every
 * other language — reddit's "Prove your humanity" page slipped past a list
 * built from reddit's own "blocked by network security" page. A captcha vendor
 * loads from a fixed host whatever the surrounding copy says.
 */
const CHALLENGE_FRAME_HOSTS = [
	{ vendor: 'recaptcha', match: /(^|\.)(google\.com|recaptcha\.net)\/recaptcha\// },
	{ vendor: 'hcaptcha', match: /(^|\.)hcaptcha\.com\// },
	{ vendor: 'turnstile', match: /challenges\.cloudflare\.com\// },
	{ vendor: 'arkose', match: /(^|\.)arkoselabs\.com\// },
	{ vendor: 'datadome', match: /(^|\.)captcha-delivery\.com\// },
];

/**
 * The interstitial a rendered page turned out to be, or null for real content.
 * Pure — takes the strings a page yields, so a test drives it with no browser.
 *
 * SEAM — three challenge detectors exist and none can replace another:
 *   - `detectChallenge(headers, status)` in packages/shared/src/transport-tier.ts
 *     reads headers only and never touches the body, so a challenge served as a
 *     rendered HTTP 200 page is invisible to it. That is this function's case.
 *   - `detectChallengePresence(rows)` in packages/browser/src/driver/manifest.ts
 *     finds vendor infrastructure in captured traffic, including on pages that
 *     render fine, and sees nothing when no capture is running.
 *   - this one reads what a browser actually painted, with no capture and no
 *     Response object available.
 * They also cannot be unified: scripts/ imports node builtins only, and both
 * others live in TypeScript this file cannot load. Keep all three.
 *
 * The length ceiling guards the false positive that matters: an article *about*
 * bot walls contains these phrases too. An interstitial is a near-empty page, so
 * a marker inside a page carrying real content is content, not a block.
 */
export function detectRenderedChallenge({ title = '', text = '', frameUrls = [] }) {
	// Widget first: it carries no length ceiling because it is not a phrase that
	// an article could quote. A page mounting a captcha is being challenged
	// however much copy surrounds it.
	for (const url of frameUrls) {
		for (const { vendor, match } of CHALLENGE_FRAME_HOSTS) {
			if (match.test(url)) return vendor;
		}
	}
	if (text.length > CHALLENGE_TEXT_CEILING) return null;
	const haystack = `${title}\n${text}`.toLowerCase();
	for (const { vendor, match } of RENDERED_CHALLENGE_MARKERS) {
		if (match.test(haystack)) return vendor;
	}
	return null;
}

// ─── Runner ──────────────────────────────────────────────────────────

const HELP = `snapshot — report-only visual capture across states and viewports

  node scripts/snapshot.mjs [--label=NAME] [--scenarios=a,b] [--viewports=a,b]
                            [--states=FILE] [--path=/x] [--headless=false] [--budget=N]
                            [--port=N] [--origin=URL] [--profile=NAME]
                            [--engine=patchright|camoufox] [--warm]
                            [--wait-until=load|domcontentloaded|networkidle] [--settle=MS] [--timeout=MS] [--wall-clock=SECONDS]

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
	const origin = resolveOrigin(opts);
	console.log(`Capturing against ${origin}`);

	// The transport ladder, applied to capture. A cold launch is the bottom rung
	// and is what a protected site refuses; `--profile` gives the engine the
	// persistent context stealth is built around, which is the same climb a
	// domain plugin makes to reach its routes.
	const profileDir = opts.profile ? resolve(ROOT, 'data/browser-profiles', opts.profile) : null;
	if (profileDir) mkdirSync(profileDir, { recursive: true });

	// Camoufox goes through the driver seam rather than being launched here.
	// Its two load-bearing settings — never true headless, and pin the persona OS
	// whenever a profile persists — live in the driver with the reasoning, and a
	// second copy in this script is exactly the two-lists drift that makes one of
	// them quietly wrong. Patchright is launched directly because this script
	// wants a raw context with no traffic capture attached.
	let session;
	let openPage;
	if (opts.engine === 'camoufox') {
		const { requireDriver } = await import('../packages/browser/src/driver/index.ts');
		const driver = await requireDriver('camoufox');
		// headless is deliberately not forwarded: the driver refuses true headless
		// and resolves the right mode per platform.
		session = await driver.launch({ profileDir: profileDir ?? undefined });
		openPage = async (viewport) => {
			const page = await session.newPage();
			await page.setViewportSize(VIEWPORTS[viewport]);
			return page;
		};
		console.log(`Engine camoufox (headed — it refuses true headless by design)`);
	} else {
		const { chromium } = await import('patchright');
		// `channel: 'chromium'` is patchright's OWN patched build. `'chrome'`
		// launches the system Google Chrome, which patchright has not patched — so
		// every stealth guarantee is silently discarded while the call still reads
		// as more legitimate for naming a real browser.
		//
		// `ignoreDefaultArgs` drops `--enable-automation`, which Playwright adds by
		// default and which sets `navigator.webdriver` regardless of the args above.
		//
		// Headless macOS forces ANGLE/Metal so the GPU fingerprint matches what the
		// same machine reports headed; without it the WebGL renderer differs and
		// that difference is itself the signal.
		const launchArgs = [
			...STEALTH_ARGS,
			...(opts.headless && process.platform === 'darwin' ? ['--use-angle=metal'] : []),
		];
		session = await chromium.launchPersistentContext(profileDir ?? '', {
			headless: opts.headless,
			channel: 'chromium',
			viewport: null,
			locale: 'en-US',
			timezoneId: 'America/New_York',
			args: launchArgs,
			ignoreDefaultArgs: ['--enable-automation'],
		});
		openPage = async (viewport) => {
			const page = await session.newPage();
			// Harden before any navigation, so no request is ever made from a page
			// still advertising headless.
			await hardenPage(page);
			await page.setViewportSize(VIEWPORTS[viewport]);
			return page;
		};
	}
	if (profileDir) console.log(`Using persistent profile ${opts.profile}`);

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
			const page = await openPage(viewport);
			const file = shotName(state.name, viewport);
			try {
				// Arrive the way a reader would: neutral history, then the origin
				// root, then the deep path with a referrer and cookies already set.
				// A hop that fails is skipped rather than failing the capture — the
				// warm chain is preparation, not the measurement.
				if (opts.warm) {
					for (const hop of warmChainFor(origin)) {
						if (hop === `${origin}${state.path}`) continue;
						await page
							.goto(hop, { waitUntil: 'domcontentloaded', timeout: opts.timeout })
							.catch(() => {});
						await page.waitForTimeout(1500);
					}
				}
				await page.goto(`${origin}${state.path}`, {
					waitUntil: opts.waitUntil,
					timeout: opts.timeout,
				});
				if (state.waitFor) {
					await page.waitForSelector(state.waitFor, { timeout: opts.timeout });
				}
				// A fixed settle covers what `load` does not: data the page fetches
				// after first paint. `networkidle` would cover it too and never
				// resolves on a page holding a stream open, which is the shape of
				// every live feed worth capturing.
				if (opts.settle > 0) await page.waitForTimeout(opts.settle);
				await page.screenshot({
					path: resolve(outDir, file),
					type: 'png',
					fullPage: opts.fullPage,
				});

				// The shot is kept either way: a challenge PNG is the evidence that
				// the site refused, and deleting it would leave only a claim.
				const challenge = detectRenderedChallenge({
					title: await page.title(),
					text: await page.evaluate(() => document.body?.innerText ?? ''),
					frameUrls: page.frames().map((f) => f.url()),
				});
				captures.push({ state: state.name, viewport, file, ms: Date.now() - t0, challenge });
				if (challenge) {
					console.log(`⚠ ${state.name} @ ${viewport} → ${file} is a ${challenge} interstitial`);
				} else {
					console.log(`✓ ${state.name} @ ${viewport} → ${file} (${Date.now() - t0}ms)`);
				}
			} catch (err) {
				captures.push({ state: state.name, viewport, file: null, error: err.message });
				console.log(`✗ ${state.name} @ ${viewport}: ${err.message}`);
			} finally {
				await page.close();
			}
		}
	} finally {
		await session.close();
	}

	const summary = {
		label: opts.label,
		startedAt: new Date(started).toISOString(),
		durationMs: Date.now() - started,
		// Provenance: a description written from these shots names where they came
		// from, so the frame can be re-captured after it is deleted.
		origin,
		viewports: VIEWPORTS,
		captures,
	};
	writeFileSync(resolve(outDir, 'summary.json'), `${JSON.stringify(summary, null, '\t')}\n`);

	// A silent cap reads as full coverage. Say what was dropped.
	if (budgetStopped > 0) {
		console.log(`\n⊘ ${budgetStopped} capture(s) not taken — budget or wall-clock reached.`);
	}

	const failures = captures.filter((c) => c.error);
	const blocked = captures.filter((c) => c.challenge);
	const secs = ((Date.now() - started) / 1000).toFixed(1);
	console.log(
		`\n${captures.length - failures.length}/${captures.length} captured in ${secs}s → .snapshots/${opts.label}/`,
	);

	// Report-only about what the pages LOOK like; still honest about not
	// having reached them at all.
	if (failures.length === captures.length) {
		console.error(`✗ Every capture failed — is ${origin} reachable?`);
		return 1;
	}

	// A challenge page renders, screenshots cleanly, and reads as a successful
	// capture — which is worse than a failure, because anything built from it
	// describes the interstitial. Refusing it here is the same contract as the
	// unreachable case above: the target was never reached. It is not a judgment
	// about how the page looks, which this tool still declines to make.
	if (blocked.length > 0) {
		const vendors = [...new Set(blocked.map((c) => c.challenge))].join(', ');
		console.error(
			`\n✗ ${blocked.length}/${captures.length} capture(s) are bot-wall interstitials (${vendors}).\n` +
				`  ${origin} refused this session. The PNGs are kept as evidence.\n` +
				'  Do not describe or build from them, and do not re-run with a tweaked\n' +
				'  header — reach the site through a browser profile that holds a session.',
		);
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
