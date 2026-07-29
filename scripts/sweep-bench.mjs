#!/usr/bin/env node
/**
 * sweep-bench — measures what the interaction layer actually reaches.
 *
 * PURPOSE
 *   `capture-bench` measures a different thing and cannot measure this one. It
 *   drives a page that calls every primitive on load, so it answers "is the
 *   instrument patched correctly" and nothing at all about provocation — a
 *   sweep that did nothing whatsoever would score 100% there. The two are a
 *   seam, not a duplicate: capture-bench holds the capture layer, this holds
 *   the interaction layer, and neither can see the other's regressions.
 *
 *   That gap hid a real defect. The benchmark reached `Form-encoded POST`
 *   through `form.submit()` — the only submission path a prototype patch sees —
 *   while a submit button and the Enter key, which is how forms are actually
 *   submitted, went uncaptured and unprovoked. The bench read 13/13 throughout.
 *
 *   So this drives the gated fixture, where nothing but one baseline call fires
 *   on load and every other endpoint answers exactly one provocation. It reads
 *   two independent sources and keeps them apart:
 *
 *     reached — the server's own hit log. Did the interaction happen?
 *     seen    — the drained capture. Did the instrument observe it?
 *
 *   Both empty means the sweep never provoked the page. Reached-but-unseen
 *   means the sweep works and the instrument is blind to that primitive. One
 *   number could not tell those apart, and they have opposite fixes.
 *
 * USAGE
 *   node scripts/sweep-bench.mjs
 *   node scripts/sweep-bench.mjs --headed --json
 *
 * OUTPUT
 *   A line per provocation showing reached and seen, the load-only baseline
 *   that proves the fixture is still gated, and the guard verdict. Exits
 *   non-zero when coverage is below --min (default 1.0), when the fixture
 *   turns out not to be gated, or when the POST-form guard was breached.
 *
 * BOUNDS
 *   One page, one sweep, against a server this script starts and stops itself.
 *   No external network, no retries, writes nothing to disk, makes no model
 *   calls. The sweep carries its own caps (actions, wall clock, per selector);
 *   --timeout ms bounds launch and navigation (default 30000).
 *
 * Importing this module runs nothing — `scoreProvocations` and `parseArgs` are
 * exported so scripts/__tests__/sweep-bench.test.mjs drives them over fixtures
 * with no browser.
 */

// ─── Arg parsing ─────────────────────────────────────────────────────

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
		driver: typeof flags.driver === 'string' ? flags.driver : 'patchright',
		headed: flags.headed === true,
		json: flags.json === true,
		timeout: Number(flags.timeout ?? 30_000),
		min: Number(flags.min ?? 1),
		help: flags.help === true || flags.h === true,
	};
}

// ─── Pure scoring ────────────────────────────────────────────────────

/**
 * Score each gated endpoint on two independent axes.
 *
 * `seen` matches on substring rather than equality because a capture records
 * the full URL with its query string, and the gate is keyed by path. A looser
 * match risks crediting the wrong row; keying on a path that starts with `/`
 * and is unique within the fixture keeps that risk at zero here and would not
 * survive being pointed at a real site, which is why this stays fixture-only.
 */
export function scoreProvocations(gated, hits, capturedUrls) {
	const hit = new Set(hits);
	const rows = Object.entries(gated).map(([path, provocation]) => ({
		path,
		provocation,
		reached: hit.has(path),
		seen: capturedUrls.some((u) => String(u).includes(path)),
	}));
	const reached = rows.filter((r) => r.reached);
	const blind = rows.filter((r) => r.reached && !r.seen);
	return {
		rows,
		reached,
		blind,
		coverage: rows.length ? reached.length / rows.length : 0,
	};
}

/** One line per provocation, with the two axes kept visibly separate. */
export function renderProvocations(score) {
	return score.rows
		.map((r) => {
			const mark = r.reached ? (r.seen ? '✓' : '~ REACHED, UNSEEN') : '✗ NOT REACHED';
			return `  ${mark.padEnd(18)} ${r.path.padEnd(18)} ${r.provocation}`;
		})
		.join('\n');
}

// ─── Runner ──────────────────────────────────────────────────────────

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log('Usage: node scripts/sweep-bench.mjs [--driver=patchright|camoufox]');
		console.log('       [--headed] [--json] [--timeout=ms] [--min=0..1]');
		return 0;
	}

	const [{ createTestServer }, gatedMod, driverMod, captureMod, sweepMod] = await Promise.all([
		import('../packages/test-server/src/index.ts'),
		import('../packages/test-server/src/sites/gatedboard.ts'),
		import('../packages/browser/src/driver/index.ts'),
		import('../packages/browser/src/driver/traffic-capture.ts'),
		import('../packages/browser/src/driver/interaction-sweep.ts'),
	]);

	const server = await createTestServer();
	const base = `${server.url}/sites/gatedboard`;
	const hitsNow = async () => (await fetch(`${base}/hits`).then((r) => r.json())).unique;
	let session;

	try {
		const driver = await driverMod.requireDriver(opts.driver);
		session = await driver.launch({ headless: !opts.headed, timeout: opts.timeout });
		const page = await session.newPage();

		const installed = await captureMod.installEgressInstrument(page);
		if (!installed) throw new Error('instrument failed to install — capture would be empty');

		// Accumulates across navigations. The sweep navigates on purpose — running a
		// query and submitting a form both replace the document — and the
		// instrument's buffer does not survive that, so a single drain at the end
		// reports only whatever the last page did.
		const collector = captureMod.startEgressCollector(page);

		// The wire, alongside the JS events — the same two sources the real
		// pipeline reduces together. Some egress touches no JavaScript primitive at
		// all: a <video> element fetching its own source is the browser acting on
		// markup, so no patch can see it and only the wire records it. Scoring
		// against JS events alone reported that as a capture failure when it was a
		// measurement that never looked.
		const wire = [];
		const stopWire = await session.startTrafficCapture(page, (req) => {
			wire.push({ method: req.method, url: req.url });
		});

		await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
		await new Promise((r) => setTimeout(r, 2_000));

		// The load-only reading. This is what proves the fixture is still gated:
		// if provocations are already reached here, later success says nothing
		// about the sweep and the whole measurement is void.
		const beforeHits = await hitsNow();
		const beforeGated = Object.keys(gatedMod.GATED_ENDPOINTS).filter((p) => beforeHits.includes(p));

		const sweep = await sweepMod.runSweep(page);
		await new Promise((r) => setTimeout(r, 1_500));

		const events = await collector.collect();
		collector.stop();
		stopWire();
		const afterHits = await hitsNow();
		const capturedUrls = [...events.map((e) => e.url), ...wire.map((w) => w.url)];
		const score = scoreProvocations(gatedMod.GATED_ENDPOINTS, afterHits, capturedUrls);

		// Reaching the POST form means the guard let a state-changing submission
		// through. That is a failure whatever the coverage number says, and it
		// fails loudly rather than costing a fraction of a score.
		const breached = afterHits.includes('/destroy');
		const gatedOk = beforeGated.length === 0;
		const baselineOk = beforeHits.includes(gatedMod.GATEDBOARD_BASELINE);

		if (opts.json) {
			console.log(
				JSON.stringify(
					{ ...score, breached, gatedOk, baselineOk, beforeGated, sweep, afterHits },
					null,
					2,
				),
			);
		} else {
			console.log('\nProvocation coverage against the gated fixture:');
			console.log(renderProvocations(score));
			console.log(
				`\n  ${score.reached.length}/${score.rows.length} = ${(score.coverage * 100).toFixed(0)}% reached` +
					`${score.blind.length ? `, ${score.blind.length} reached but unseen` : ''}`,
			);
			console.log(
				`  baseline on load : ${baselineOk ? 'present' : 'MISSING — the page never ran'}`,
			);
			console.log(
				`  fixture gated    : ${gatedOk ? 'yes' : `NO — fired on load: ${beforeGated.join(', ')}`}`,
			);
			console.log(
				`  POST-form guard  : ${breached ? 'BREACHED — a state-changing form was submitted' : 'held'}`,
			);
			console.log(
				`  sweep            : ${sweep.performed.length} performed, ${sweep.skipped.length} skipped`,
			);
			console.log(
				`  captured         : ${events.length} JS event(s) + ${wire.length} wire event(s)\n`,
			);
		}

		if (breached || !gatedOk || !baselineOk) return 1;
		return score.coverage >= opts.min && score.blind.length === 0 ? 0 : 1;
	} finally {
		// A failing run still frees the port; leaving one bound makes the next run
		// fail for a reason that has nothing to do with the sweep.
		await session?.close().catch(() => {});
		await server.close().catch(() => {});
	}
}

// Importing this module must run nothing, so the entry point is guarded.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(`sweep-bench failed: ${err?.stack ?? err}`);
			process.exit(2);
		});
}
