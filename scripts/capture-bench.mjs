#!/usr/bin/env node
/**
 * capture-bench — measures what the capture layer actually recovers.
 *
 * PURPOSE
 *   Unit tests prove the instrument's patches are wired, by evaluating the
 *   shipped source against a fake global. They cannot prove those patches
 *   survive a real engine: whether an init script lands before page scripts,
 *   whether the main-world bridge reaches the world that matters, whether
 *   wrapping a constructor breaks a real `WebSocket`. Every one of those fails
 *   silently — capture comes back thin and the run reads it as a quiet site.
 *
 *   So this drives a real browser at the benchmark page, which reaches for
 *   every egress primitive on load and declares what it reached for. Recall
 *   becomes a number: recovered over declared, with the misses named.
 *
 *   Run it after any change to the instrument, the bridge, or the driver. A
 *   drop is a capture regression, and the named misses say which primitive.
 *
 * USAGE
 *   node scripts/capture-bench.mjs
 *   node scripts/capture-bench.mjs --driver=camoufox
 *   node scripts/capture-bench.mjs --headed --json
 *
 * OUTPUT
 *   The derived elimination table, the recall fraction, and a line per missed
 *   transport. Exits non-zero when recall is below --min (default 1.0), so this
 *   is usable as a gate rather than only as a report.
 *
 * BOUNDS
 *   One page load against a server this script starts and stops itself. No
 *   external network. --settle ms waited for late calls (default 6000, max
 *   30000). --timeout ms for browser launch and navigation (default 30000).
 *   No retries: a thin capture is the finding. Writes nothing to disk, makes no
 *   model calls, and never runs against a site it did not start.
 *
 * Importing this module runs nothing — `scoreRecall` and `parseArgs` are
 * exported so scripts/__tests__/capture-bench.test.mjs drives them over
 * fixtures with no browser.
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
		// Capped, because an unbounded settle turns a hung page into a hung gate.
		settle: Math.min(Number(flags.settle ?? 6_000), 30_000),
		timeout: Number(flags.timeout ?? 30_000),
		min: Number(flags.min ?? 1),
		help: flags.help === true || flags.h === true,
	};
}

// ─── Pure scoring ────────────────────────────────────────────────────

/**
 * Score what the capture recovered against what the page declared.
 *
 * Extra transports are reported rather than ignored: the page declares what it
 * deliberately emits, so anything beyond that is either a browser calling home
 * or a classifier attributing an event to the wrong row. Both are worth seeing,
 * and neither should quietly inflate recall.
 */
export function scoreRecall(declared, verdicts) {
	const present = new Set(verdicts.filter((v) => v.present).map((v) => v.transport));
	const found = declared.filter((t) => present.has(t));
	const missed = declared.filter((t) => !present.has(t));
	const extra = [...present].filter((t) => !declared.includes(t)).sort();
	return {
		found,
		missed,
		extra,
		recall: declared.length ? found.length / declared.length : 0,
	};
}

/** One line per transport, marking what was recovered and what was not. */
export function renderScore(score, declared) {
	const lines = declared.map((t) => `  ${score.found.includes(t) ? '✓' : '✗ MISSED'}  ${t}`);
	if (score.extra.length) lines.push(`  +  beyond the declaration: ${score.extra.join(', ')}`);
	return lines.join('\n');
}

// ─── Runner ──────────────────────────────────────────────────────────

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log('Usage: node scripts/capture-bench.mjs [--driver=patchright|camoufox]');
		console.log('       [--headed] [--json] [--settle=ms] [--min=0..1]');
		return 0;
	}

	const [{ createTestServer }, { BENCHMARK_TRANSPORTS }, driverMod, captureMod, manifestMod] =
		await Promise.all([
			import('../packages/test-server/src/index.ts'),
			import('../packages/test-server/src/sites/benchmark.ts'),
			import('../packages/browser/src/driver/index.ts'),
			import('../packages/browser/src/driver/traffic-capture.ts'),
			import('../packages/browser/src/driver/manifest.ts'),
		]);

	const declared = [...BENCHMARK_TRANSPORTS];
	const server = await createTestServer();
	let session;

	try {
		const driver = await driverMod.requireDriver(opts.driver);
		session = await driver.launch({ headless: !opts.headed, timeout: opts.timeout });
		const page = await session.newPage();

		// Wire capture first: a response that arrives before the listener is
		// attached is a gap the manifest would report as an absent transport.
		const wire = [];
		const stop = await session.startTrafficCapture(page, (req) => {
			wire.push({ method: req.method, url: req.url, body: req.body });
		});

		// Must precede navigation. Installed after, it misses exactly the calls a
		// page makes while starting up, which is most of them.
		const installed = await captureMod.installEgressInstrument(page);
		if (!installed) throw new Error('instrument failed to install — capture would be empty');

		await page.goto(`${server.url}/sites/benchmark/`, {
			waitUntil: 'domcontentloaded',
			timeout: opts.timeout,
		});
		await new Promise((r) => setTimeout(r, opts.settle));

		const events = await captureMod.drainEgressEvents(page);
		stop();

		const rows = manifestMod.buildManifest(events, wire);
		const verdicts = manifestMod.deriveTransports(rows);
		const score = scoreRecall(declared, verdicts);

		if (opts.json) {
			console.log(JSON.stringify({ driver: opts.driver, ...score, rows, verdicts }, null, 2));
		} else {
			console.log(`\n${manifestMod.renderTransports(verdicts)}\n`);
			console.log(
				`Manifest: ${rows.length} row(s) from ${events.length} JS event(s) + ${wire.length} wire event(s)`,
			);
			console.log(`\nRecall against the benchmark's declaration:`);
			console.log(renderScore(score, declared));
			console.log(
				`\n  ${score.found.length}/${declared.length} = ${(score.recall * 100).toFixed(0)}%  [${opts.driver}]\n`,
			);
		}

		return score.recall >= opts.min ? 0 : 1;
	} finally {
		// A failing run still frees the port; leaving one bound makes the next run
		// fail for a reason that has nothing to do with capture.
		await session?.close().catch(() => {});
		await server.close().catch(() => {});
	}
}

// Importing this module must run nothing, so the entry point is guarded.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(`capture-bench failed: ${err?.stack ?? err}`);
			process.exit(2);
		});
}
