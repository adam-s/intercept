#!/usr/bin/env node
/**
 * route-spec — the asserting tier over domain proxy routes.
 *
 * PURPOSE
 *   Every registered domain route is called through the running API server and
 *   checked against the contract in AGENTS.md §"Product invariants": a route
 *   returns JSON it actually received, and reports what it actually got. This
 *   is the layer that ASSERTS. It complements the report-only tools
 *   (capture-traffic.sh, snapshot.mjs) — those print, this exits non-zero.
 *
 *   Four checks per route:
 *     status        — 2xx, and not a bot-wall interstitial
 *     content-type  — JSON, because a proxy route that serves markup has
 *                     silently handed back an error page
 *     completeness  — an indicated total larger than the returned item count
 *                     must come with an explicit incomplete signal. Silent
 *                     truncation is the defect this check exists to catch.
 *     shape         — the response's structural fingerprint against a recorded
 *                     baseline, so live-site drift surfaces as a verdict
 *                     instead of a mystery
 *
 * USAGE
 *   node scripts/route-spec.mjs                        # assert against the recorded baseline
 *   node scripts/route-spec.mjs --record               # write/refresh the baseline, assert the rest
 *   node scripts/route-spec.mjs --domain=boardshop     # one domain only
 *   node scripts/route-spec.mjs --label=pre-deploy     # name this run's artifact dir
 *   node scripts/route-spec.mjs --budget=20            # cap routes probed
 *   node scripts/route-spec.mjs --port=3001 --timeout=45000
 *
 * BOUNDS
 *   At most --budget routes (default 40), one request each, --timeout ms per
 *   request (default 45000), and a hard --wall-clock ceiling (default 300s) for
 *   the whole run. The per-request default is deliberately generous: a route
 *   that drives a real browser can legitimately take tens of seconds, and a
 *   timeout tight enough to abort it reports "hung" for work that was merely
 *   slow. The wall-clock ceiling is what bounds the run.
 *
 *   No retries: an unexpected response is the finding. Baselines
 *   live in data/route-spec-baseline/<domain>.json (committed, small — shapes
 *   only, never response bodies, so no captured data lands in git). Run
 *   artifacts go to .route-spec/<label>/ (gitignored). No model calls. Nothing
 *   is written outside those two directories.
 *
 *   A passing run deletes its artifact directory. A failing run leaves it in
 *   place for inspection and exits 1.
 *
 * Importing this module runs nothing — the pure checks are exported so
 * scripts/__tests__/route-spec.test.mjs drives them over fixtures with no
 * network and no server.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_DIR = resolve(ROOT, 'data/route-spec-baseline');

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
		record: flags.record === true,
		domain: typeof flags.domain === 'string' ? flags.domain : null,
		label: typeof flags.label === 'string' ? flags.label : 'latest',
		// The reference domain alone exceeds 40 routes, so a lower default made a
		// full run silently partial — and "8 not probed" reads a lot like "8
		// passed" at a glance.
		budget: Number(flags.budget ?? 100),
		allowInstrumented: flags['allow-instrumented'] === true,
		port: Number(flags.port ?? 3001),
		timeout: Number(flags.timeout ?? 45_000),
		wallClock: Number(flags['wall-clock'] ?? 300) * 1000,
		help: flags.help === true || flags.h === true,
	};
}

// ─── Pure checks ─────────────────────────────────────────────────────

/**
 * Structural fingerprint of a JSON value — types and keys, never values.
 *
 * Values are deliberately excluded: a baseline that recorded them would be a
 * captured copy of the target's data, which must not land in git, and it would
 * go red on every ordinary content change rather than on a shape change.
 */
export function shapeOf(value, depth = 0) {
	if (depth > 6) return '…';
	if (value === null) return 'null';
	if (Array.isArray(value)) {
		// One element stands for the array: a shape check asks whether the
		// element type changed, not how many arrived. Count is the
		// completeness check's job.
		return value.length === 0 ? '[]' : `[${shapeOf(value[0], depth + 1)}]`;
	}
	if (typeof value === 'object') {
		const keys = Object.keys(value).sort();
		return `{${keys.map((k) => `${k}:${shapeOf(value[k], depth + 1)}`).join(',')}}`;
	}
	return typeof value;
}

/** Field names sites use for "here are the items". */
const ITEM_KEYS = ['items', 'data', 'results', 'entries', 'records', 'rows', 'products', 'list'];
/** Field names sites use for "this is how many exist". */
const TOTAL_KEYS = ['total', 'totalCount', 'total_count', 'totalItems', 'totalResults', 'count'];
/** Fields whose presence means the route already told the truth about truncation. */
const INCOMPLETE_KEYS = [
	'hasMore',
	'has_more',
	'nextCursor',
	'next_cursor',
	'nextPage',
	'complete',
	'incomplete',
	'truncated',
];

/**
 * The completeness contract: a route reports what it actually got.
 *
 * Returns `{ verdict, itemCount, indicatedTotal, detail }` where verdict is
 * 'complete' | 'incomplete-declared' | 'silent-truncation' | 'not-applicable'.
 * Only 'silent-truncation' is a failure — the route returned fewer items than
 * it said exist and said nothing about it.
 */
export function checkCompleteness(body) {
	if (body === null || typeof body !== 'object') {
		return { verdict: 'not-applicable', detail: 'response is not an object' };
	}

	const items = Array.isArray(body)
		? body
		: (ITEM_KEYS.map((k) => body[k]).find(Array.isArray) ?? null);
	if (items === null) {
		return { verdict: 'not-applicable', detail: 'no item collection found' };
	}

	const totalKey = Array.isArray(body) ? null : TOTAL_KEYS.find((k) => typeof body[k] === 'number');
	if (!totalKey) {
		return { verdict: 'not-applicable', itemCount: items.length, detail: 'no indicated total' };
	}

	const indicatedTotal = body[totalKey];
	if (items.length >= indicatedTotal) {
		return { verdict: 'complete', itemCount: items.length, indicatedTotal };
	}

	// The route returned fewer than it claims exist. That is fine only if it
	// said so — a cursor, a hasMore flag, an explicit incomplete marker.
	const declared = INCOMPLETE_KEYS.find(
		(k) => body[k] !== undefined && body[k] !== null && body[k] !== false,
	);
	if (declared) {
		return {
			verdict: 'incomplete-declared',
			itemCount: items.length,
			indicatedTotal,
			detail: `declared via "${declared}"`,
		};
	}

	return {
		verdict: 'silent-truncation',
		itemCount: items.length,
		indicatedTotal,
		detail: `returned ${items.length} of ${indicatedTotal} (via "${totalKey}") with no incompleteness signal`,
	};
}

/**
 * Compare a response's shape against its recorded baseline.
 *
 * Verdict vocabulary is deliberate and matches the snapshot-diff convention:
 * 'no-signal-flipped' | 'new-route' | 'unexpected-regression'.
 */
export function diffShape(baselineShape, actualShape) {
	if (baselineShape === undefined) {
		return { verdict: 'new-route', detail: 'no baseline recorded' };
	}
	// A baseline is a SET of accepted shapes, not one shape. Some routes vary
	// legitimately — an escalation route returns the API's shape on a first call
	// and its fallback's shape once the upstream rate-limits. Pinning such a
	// route to whichever shape got recorded first turns designed behavior into a
	// permanent red. Record mode accumulates; assert passes on any member.
	const accepted = Array.isArray(baselineShape) ? baselineShape : [baselineShape];
	if (accepted.includes(actualShape)) {
		return { verdict: 'no-signal-flipped' };
	}
	if (accepted.length > 1) {
		return {
			verdict: 'unexpected-regression',
			detail: `shape matches none of ${accepted.length} recorded shapes\n      now: ${truncate(actualShape, 300)}`,
		};
	}
	return {
		verdict: 'unexpected-regression',
		detail: `shape changed\n      was: ${truncate(accepted[0], 300)}\n      now: ${truncate(actualShape, 300)}`,
	};
}

function truncate(s, n) {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Every check for one route's response, as a list of findings. Pure. */
export function checkResponse({ status, contentType, body, baselineShape }) {
	const findings = [];

	if (status < 200 || status >= 300) {
		findings.push({ check: 'status', detail: `HTTP ${status}` });
	}

	const isJson = /json/i.test(contentType ?? '');
	if (!isJson) {
		findings.push({
			check: 'content-type',
			detail: `${contentType || 'none'} — a proxy route serving non-JSON has handed back an error or challenge page`,
		});
	}

	// The remaining checks need a parsed body; skip rather than double-report.
	if (body === undefined) return findings;

	const completeness = checkCompleteness(body);
	if (completeness.verdict === 'silent-truncation') {
		findings.push({ check: 'completeness', detail: completeness.detail });
	}

	const shape = diffShape(baselineShape, shapeOf(body));
	if (shape.verdict === 'unexpected-regression') {
		findings.push({ check: 'shape', detail: shape.detail });
	}

	return findings;
}

/** Routes this tier can probe unattended: GET, no path parameters. */
export function isProbeable(route) {
	return route.startsWith('GET ') && !route.includes(':') && !route.includes('*');
}

/**
 * The concrete URLs to probe for a domain, and what got left out.
 *
 * A declared example always wins: a route with a path parameter or a required
 * query parameter is not callable from its declaration alone, and skipping it
 * silently is how a checker reports green over routes nothing ever called.
 * Examples are matched to their route by path prefix so a route that declares
 * one is never also probed bare.
 */
/**
 * Routes that failed to declare what the checker needs from them.
 *
 * `examples` and `upstream` are both obligations the discovery rule states, and
 * only one of them was ever enforced here. The other was demonstrated in the
 * reference domain, stated in the rule, and dropped — by an agent that declared
 * `examples` seven times in the same run. An obligation nothing checks is a
 * suggestion, so both are checked.
 *
 * A `targetUrl` route is exempt from `upstream`: its target *is* the upstream,
 * so declaring it again would be a second copy to drift.
 */
export function undeclared(routes = []) {
	const missing = [];
	for (const r of routes) {
		const path = typeof r === 'string' ? r : r.path;
		const rec = typeof r === 'string' ? {} : r;
		const needsExample = /[:*]/.test(String(path));
		if (needsExample && !(rec.examples ?? []).length) {
			missing.push({
				route: path,
				field: 'examples',
				why: 'has a path parameter, so it cannot be called from its declaration alone',
			});
		}
		// The index sends `hasTargetUrl`; a plugin object would carry `targetUrl`.
		// Accept either, so this works against the wire shape and the source shape.
		const proxies = Boolean(rec.hasTargetUrl ?? rec.targetUrl);
		if (!proxies && !(rec.upstream ?? []).length) {
			missing.push({
				route: path,
				field: 'upstream',
				why: 'the coverage check cannot recover what a route calls from its own path',
			});
		}
	}
	return missing;
}

export function probeTargets(routes = [], examples = []) {
	const exampleTargets = examples.filter((e) => e.startsWith('GET ')).map((e) => e.slice(4));
	const covered = new Set();
	for (const target of exampleTargets) {
		const base = target.split('?')[0];
		for (const route of routes) {
			const path = route.replace(/^[A-Z]+ /, '');
			const stem = path.split('/:')[0].split('/*')[0];
			if (base === path || base.startsWith(`${stem}/`) || base === stem) covered.add(route);
		}
	}

	const bare = routes.filter((r) => isProbeable(r) && !covered.has(r)).map((r) => r.slice(4));
	const skipped = routes.filter((r) => !covered.has(r) && !isProbeable(r));

	return { targets: [...exampleTargets, ...bare], skipped };
}

// ─── Runner ──────────────────────────────────────────────────────────

const HELP = `route-spec — assert every domain proxy route against its contract

  node scripts/route-spec.mjs [--record] [--domain=NAME] [--label=NAME]
                              [--budget=N] [--port=N] [--timeout=MS]
                              [--wall-clock=SECONDS]

Read the header docblock in this file for the bounds this run will respect.`;

async function fetchJson(url, timeout) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);
	try {
		const res = await fetch(url, { signal: controller.signal });
		const contentType = res.headers.get('content-type');
		const text = await res.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}
		return { status: res.status, contentType, body, raw: text };
	} finally {
		clearTimeout(timer);
	}
}

function readBaseline(domain) {
	try {
		return JSON.parse(readFileSync(resolve(BASELINE_DIR, `${domain}.json`), 'utf8'));
	} catch {
		return {};
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(HELP);
		return 0;
	}

	const started = Date.now();
	const base = `http://localhost:${opts.port}`;
	const artifactDir = resolve(ROOT, '.route-spec', opts.label);
	mkdirSync(artifactDir, { recursive: true });

	let index;
	try {
		index = await fetchJson(`${base}/api`, opts.timeout);
	} catch (err) {
		console.error(`✗ API server not reachable on port ${opts.port}: ${err.message}`);
		console.error('  Start it first — see docs/ARCHITECTURE.md.');
		return 1;
	}
	if (!index.body?.domains) {
		console.error(`✗ GET ${base}/api did not return a domain index (HTTP ${index.status}).`);
		return 1;
	}

	const domains = index.body.domains.filter((d) => !opts.domain || d.name === opts.domain);
	if (domains.length === 0) {
		console.error(`✗ No registered domain named "${opts.domain}".`);
		return 1;
	}

	// GATE: an assertion run against an instrumented session measures a page no
	// ordinary visitor sees — patched primitives, aids installed — so a pass here
	// says nothing about what a clean session would get, and a block during one
	// says nothing about the site. Refuse rather than produce a number that reads
	// like a verdict. See the two-pass rule in .agents/rules/discovery.md.
	if (!opts.allowInstrumented) {
		// fetchJson returns { status, body } — reading `state.instrumented` here
		// silently yields undefined and the gate never fires, which is exactly the
		// unfalsifiable green this gate exists to prevent.
		const state = await fetchJson(`${base}/browser/instrument`, opts.timeout).catch(() => null);
		if (state?.body?.instrumented === true) {
			console.error(
				'✗ This session is instrumented — discovery aids are still installed.\n' +
					'  route-spec asserts what a clean session gets, and an instrumented page is not that.\n' +
					'  Run: node scripts/discover-probe.mjs --mode=uninstall\n' +
					'  Then re-run. Use --allow-instrumented only to debug the checker itself.',
			);
			return 1;
		}
	}

	const results = [];
	const baselines = {};
	let probed = 0;
	let skippedForBudget = 0;
	let skippedUnprobeable = 0;
	let declarationFailures = 0;

	outer: for (const domain of domains) {
		baselines[domain.name] = opts.record ? {} : readBaseline(domain.name);
		const recorded = opts.record ? baselines[domain.name] : null;
		const existing = opts.record ? readBaseline(domain.name) : baselines[domain.name];

		// GATE: a route that did not declare what the checker needs is a route the
		// checker cannot honestly assert. Failing here rather than skipping is the
		// point — a silently skipped route reads exactly like a passing one.
		const missing = undeclared(domain.routeDetail ?? []);
		if (missing.length) {
			console.error(
				`\n✗ ${domain.name}: ${missing.length} route(s) missing a required declaration:`,
			);
			for (const m of missing.slice(0, 20)) {
				console.error(`    ${m.route} — no ${m.field}: ${m.why}`);
			}
			if (missing.length > 20) console.error(`    … ${missing.length - 20} more`);
			declarationFailures += missing.length;
			continue;
		}

		const { targets, skipped } = probeTargets(domain.routes ?? [], domain.examples ?? []);
		skippedUnprobeable += skipped.length;

		for (const target of targets) {
			const route = `GET ${target}`;
			if (probed >= opts.budget) {
				skippedForBudget++;
				continue;
			}
			if (Date.now() - started > opts.wallClock) {
				console.error(`\n✗ Wall-clock ceiling (${opts.wallClock / 1000}s) reached — stopping.`);
				break outer;
			}

			const path = target;
			probed++;

			const t0 = Date.now();
			let res;
			try {
				res = await fetchJson(`${base}${path}`, opts.timeout);
			} catch (err) {
				results.push({
					domain: domain.name,
					route,
					ms: Date.now() - t0,
					findings: [{ check: 'request', detail: err.message }],
				});
				continue;
			}

			const shape = res.body === undefined ? null : shapeOf(res.body);
			if (recorded && shape) {
				const seen = new Set(
					Array.isArray(recorded[route])
						? recorded[route]
						: recorded[route]
							? [recorded[route]]
							: [],
				);
				const prior = existing[route];
				for (const v of Array.isArray(prior) ? prior : prior ? [prior] : []) seen.add(v);
				seen.add(shape);
				recorded[route] = [...seen];
			}

			const findings = checkResponse({
				status: res.status,
				contentType: res.contentType,
				body: res.body,
				// In --record mode the shape check is vacuous by construction, so
				// skip it rather than assert a value against itself.
				baselineShape: opts.record ? shape : existing[route],
			});

			results.push({
				domain: domain.name,
				route,
				ms: Date.now() - t0,
				status: res.status,
				findings,
				completeness: res.body === undefined ? null : checkCompleteness(res.body),
			});
		}
	}

	if (opts.record) {
		mkdirSync(BASELINE_DIR, { recursive: true });
		for (const [domain, shapes] of Object.entries(baselines)) {
			const file = resolve(BASELINE_DIR, `${domain}.json`);
			writeFileSync(file, `${JSON.stringify(shapes, null, '\t')}\n`);
			console.log(
				`  recorded ${Object.keys(shapes).length} shapes → data/route-spec-baseline/${domain}.json`,
			);
		}
	}

	// ─── Report ──────────────────────────────────────────────────────
	const failed = results.filter((r) => r.findings.length > 0);

	for (const r of results) {
		const mark = r.findings.length === 0 ? '✓' : '✗';
		const counts =
			r.completeness && r.completeness.itemCount !== undefined
				? ` [${r.completeness.itemCount}${r.completeness.indicatedTotal !== undefined ? `/${r.completeness.indicatedTotal}` : ''} items]`
				: '';
		console.log(`${mark} ${r.route}${counts} ${r.ms}ms`);
		for (const f of r.findings) console.log(`    ${f.check}: ${f.detail}`);
	}

	const report = {
		startedAt: new Date(started).toISOString(),
		durationMs: Date.now() - started,
		probed,
		failed: failed.length,
		skippedForBudget,
		skippedUnprobeable,
		results,
	};
	writeFileSync(resolve(artifactDir, 'report.json'), `${JSON.stringify(report, null, '\t')}\n`);

	// Silent caps read as "covered everything" when they didn't. Say so.
	if (skippedForBudget > 0) {
		console.log(`\n⊘ ${skippedForBudget} route(s) not probed — --budget=${opts.budget} reached.`);
	}
	if (skippedUnprobeable > 0) {
		console.log(
			`⊘ ${skippedUnprobeable} route(s) not probed — not GET, or a path/query parameter is required and the route declares no \`examples\`. A route nothing calls is not a route this tier has checked.`,
		);
	}

	const secs = ((Date.now() - started) / 1000).toFixed(1);
	// A missing declaration is a failure of the suite, not of a route that ran —
	// counting it among the passes would let a domain go green while whole routes
	// were never asserted at all.
	if (declarationFailures > 0) {
		console.log(
			`\n✗ ${declarationFailures} undeclared route(s). Every route declares \`upstream\`, and any route with a path or required query parameter declares \`examples\`.`,
		);
		return 1;
	}
	if (failed.length === 0) {
		console.log(`\n✓ ${probed} route(s) passed in ${secs}s.`);
		rmSync(artifactDir, { recursive: true, force: true });
		return 0;
	}

	console.log(`\n✗ ${failed.length} of ${probed} route(s) failed in ${secs}s.`);
	console.log(`  Artifacts kept: .route-spec/${opts.label}/report.json`);
	return 1;
}

// Importing runs nothing; a unit test drives the exported checks directly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
