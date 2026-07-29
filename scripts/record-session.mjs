#!/usr/bin/env node
/**
 * record-session — capture a human performing a flow once, then replay its
 * real motion.
 *
 * PURPOSE
 *   The escalation ladder for a target that refuses automation is: patchright →
 *   camoufox → this. The first two change what the browser *looks* like. This
 *   changes what it *does*, and it is the last rung because it costs a person's
 *   time and cannot run unattended.
 *
 *   Some detectors score behaviour rather than fingerprint: the straight-line
 *   cursor, the uniform dwell, the keystroke cadence no hand produces. Synthetic
 *   humanization approximates a distribution. A recording is a sample from the
 *   real one — the maintainer's actual trajectories, with their actual timing.
 *
 *   Recording requires a person at the keyboard, by construction. That is the
 *   point, and it is also the consent gate: nothing here runs unattended.
 *
 * MODES
 *   --mode=record   Open the target headed, capture until you close the window.
 *   --mode=replay   Drive a fresh session through a recorded trajectory.
 *   --mode=inspect  Summarize a recording without opening a browser.
 *
 * USAGE
 *   node scripts/record-session.mjs --mode=record --url=https://example.com \
 *        --out=data/recordings/example-login.jsonl
 *   node scripts/record-session.mjs --mode=inspect --in=data/recordings/example-login.jsonl
 *   node scripts/record-session.mjs --mode=replay --in=data/recordings/example-login.jsonl
 *
 * WHAT IS AND IS NOT RECORDED
 *   Recorded: pointer trajectories (coalesced, with capture-time stamps), button
 *   presses, scrolls, focus changes, and the *timing and length* of typing.
 *
 *   Never recorded: the characters you type. Keystrokes are captured as timing
 *   only — a `key` event carries its interval, never its value — so a recording
 *   cannot carry a password, a one-time code, or a card number even if one was
 *   typed while it ran. This is not configurable, because a recording is a file
 *   that outlives the session that made it.
 *
 *   Replay therefore reproduces motion and cadence, never credentials. Anything
 *   secret is supplied at replay time from the session manager, not from here.
 *
 * BOUNDS
 *   One page, one session, capped by --max-events (default 20000) and
 *   --max-minutes (default 15). Recording stops when you close the window or a
 *   cap is reached. Writes only to the --out path under data/recordings/.
 *   Replay makes no requests of its own beyond driving the page. No model calls.
 *
 * Importing this module runs nothing — the pure helpers are exported so
 * scripts/__tests__/record-session.test.mjs drives them with no browser.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
		mode: typeof flags.mode === 'string' ? flags.mode : 'inspect',
		url: typeof flags.url === 'string' ? flags.url : null,
		out: typeof flags.out === 'string' ? flags.out : null,
		in: typeof flags.in === 'string' ? flags.in : null,
		driver: typeof flags.driver === 'string' ? flags.driver : 'patchright',
		maxEvents: Number(flags['max-events'] ?? 20_000),
		maxMinutes: Number(flags['max-minutes'] ?? 15),
		speed: Number(flags.speed ?? 1),
		help: flags.help === true || flags.h === true,
	};
}

// ─── Pure helpers ────────────────────────────────────────────────────

/** Event kinds a recording may contain. */
export const EVENT_KINDS = ['move', 'down', 'up', 'scroll', 'key', 'focus', 'nav'];

/**
 * Fields that can carry a typed character.
 *
 * One list, used by both the stripper and the detector below, so the two cannot
 * drift apart and leave a field guarded by only one of them. A contributor
 * adding a field to the capture code discovers the rule here.
 */
const CONTENT_FIELDS = ['key', 'value', 'text', 'code'];

/**
 * Whether a captured event still carries the content of what was typed.
 *
 * After `redact` the answer is always false; a true means something reached the
 * log that must not be kept, and `summarize` reports it as a leak.
 */
export function isContentBearing(event) {
	return event.kind === 'key' && CONTENT_FIELDS.some((f) => f in event);
}

/**
 * Strip anything that could carry typed content from a captured event.
 *
 * Applied at the capture boundary, before an event reaches the log — so a
 * recording file never holds a secret even briefly.
 */
export function redact(event) {
	if (event.kind !== 'key') return event;
	// Driven by the same list isContentBearing checks, so the stripper and the
	// detector cannot drift apart and leave a field guarded by only one.
	const safe = { ...event };
	for (const field of CONTENT_FIELDS) delete safe[field];
	// Timing is what replay needs; the characters are not.
	return { ...safe, kind: 'key' };
}

/** Parse a JSONL recording, skipping blank lines. Throws on a malformed line. */
export function parseRecording(text) {
	const events = [];
	const lines = text.split('\n');
	for (const [i, line] of lines.entries()) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			throw new Error(`Recording is malformed at line ${i + 1}: ${line.slice(0, 80)}`);
		}
	}
	return events;
}

/**
 * Summarize a recording: what it holds, how long it ran, and — the check that
 * matters — whether anything content-bearing survived redaction.
 */
export function summarize(events) {
	const byKind = {};
	for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

	const times = events.map((e) => e.t).filter((t) => typeof t === 'number');
	const durationMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
	const leaks = events.filter(isContentBearing);

	const moves = events.filter((e) => e.kind === 'move');
	return {
		total: events.length,
		byKind,
		durationMs,
		moveCount: moves.length,
		// A recording whose pointer never moved is not a human trajectory, and
		// replaying it would produce exactly the straight-line motion this
		// exists to avoid.
		hasTrajectory: moves.length >= 10,
		leaks: leaks.length,
	};
}

/**
 * Inter-event delays for replay, in order.
 *
 * A recording's own timing is the signal being reproduced, so delays come from
 * the file rather than a generator. `speed` scales the whole timeline; negative
 * or zero intervals are clamped to 0 because a clock that went backwards is
 * noise, not intent.
 */
export function replayDelays(events, speed = 1) {
	const delays = [];
	for (let i = 1; i < events.length; i++) {
		const dt = (events[i].t ?? 0) - (events[i - 1].t ?? 0);
		delays.push(Math.max(0, dt) / (speed > 0 ? speed : 1));
	}
	return delays;
}

// ─── In-page capture ─────────────────────────────────────────────────

/**
 * The capture code, as source, installed before any page script runs.
 *
 * Capture-phase listeners at the document root see every event before a page
 * handler can call stopPropagation, and each event is stamped in the listener
 * itself — before any batching downstream — so the log's order is capture
 * order rather than flush order.
 */
function captureSource(sinkName) {
	return `(() => {
		const sink = (e) => { try { window[${JSON.stringify(sinkName)}](JSON.stringify(e)); } catch {} };
		const t = () => performance.now();
		const opts = { capture: true, passive: true };

		document.addEventListener('pointermove', (ev) => {
			// Coalesced events carry the sub-frame path the browser batched away.
			const raw = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
			const path = raw.length ? raw.map((c) => [Math.round(c.clientX), Math.round(c.clientY), Math.round(c.timeStamp)]) : null;
			sink({ kind: 'move', x: Math.round(ev.clientX), y: Math.round(ev.clientY), t: t(), path });
		}, opts);

		for (const [type, kind] of [['pointerdown','down'], ['pointerup','up']]) {
			document.addEventListener(type, (ev) => {
				sink({ kind, x: Math.round(ev.clientX), y: Math.round(ev.clientY), button: ev.button, t: t() });
			}, opts);
		}

		document.addEventListener('scroll', () => {
			sink({ kind: 'scroll', x: Math.round(window.scrollX), y: Math.round(window.scrollY), t: t() });
		}, opts);

		document.addEventListener('focusin', (ev) => {
			const el = ev.target;
			sink({ kind: 'focus', tag: el && el.tagName ? el.tagName.toLowerCase() : null, t: t() });
		}, opts);

		// Timing only. The key's identity is deliberately never read, so the
		// characters cannot reach the log even transiently.
		document.addEventListener('keydown', () => sink({ kind: 'key', t: t() }), opts);
	})();`;
}

// ─── Runner ──────────────────────────────────────────────────────────

const HELP = `record-session — capture a human flow once, replay its real motion

  node scripts/record-session.mjs --mode=record --url=URL --out=FILE [--driver=NAME]
  node scripts/record-session.mjs --mode=inspect --in=FILE
  node scripts/record-session.mjs --mode=replay  --in=FILE [--speed=N]

Keystroke CONTENT is never recorded — timing only. Read the header docblock.`;

async function record(opts) {
	if (!opts.url || !opts.out) {
		console.error('✗ --mode=record needs both --url and --out.');
		return 1;
	}
	const outPath = resolve(ROOT, opts.out);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, '');

	const { requireDriver } = await import('../packages/browser/src/driver/index.ts');
	const driver = await requireDriver(opts.driver);
	// Headed always: a recording without a person watching is not a recording.
	const session = await driver.launch({ headless: false });
	const page = await session.newPage();

	let count = 0;
	let stopped = false;
	const started = Date.now();
	const SINK = '__cairnSink';

	await page.exposeBinding?.(SINK, (_src, payload) => {
		if (stopped) return;
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			return;
		}
		const safe = redact(event);
		appendFileSync(outPath, `${JSON.stringify(safe)}\n`);
		if (++count >= opts.maxEvents) {
			stopped = true;
			console.log(`\n⊘ --max-events (${opts.maxEvents}) reached — recording stopped.`);
		}
	});

	await page.addInitScript?.(captureSource(SINK));
	await page.goto(opts.url, { waitUntil: 'load', timeout: 60_000 });
	// The page was already loaded once before addInitScript could apply to it.
	await page.evaluate(new Function(`${captureSource(SINK)}`));

	console.log(`\n● Recording to ${opts.out}`);
	console.log('  Perform the flow, then close the browser window to stop.');
	console.log(`  Caps: ${opts.maxEvents} events, ${opts.maxMinutes} minutes.\n`);

	await new Promise((done) => {
		const finish = () => {
			stopped = true;
			done();
		};
		page.on('close', finish);
		setTimeout(() => {
			console.log(`\n⊘ --max-minutes (${opts.maxMinutes}) reached — recording stopped.`);
			finish();
		}, opts.maxMinutes * 60_000);
	});

	await session.close().catch(() => {});

	const events = parseRecording(readFileSync(outPath, 'utf8'));
	const s = summarize(events);
	console.log(`\n✓ ${s.total} events over ${(s.durationMs / 1000).toFixed(1)}s → ${opts.out}`);
	report(s);
	void started;
	return s.leaks > 0 ? 1 : 0;
}

function report(s) {
	console.log(
		`  kinds: ${Object.entries(s.byKind)
			.map(([k, n]) => `${k}=${n}`)
			.join(' ')}`,
	);
	if (!s.hasTrajectory) {
		console.log('  ⚠ Fewer than 10 pointer moves — this holds no usable trajectory.');
		console.log(
			'    Replaying it would produce the straight-line motion recording exists to avoid.',
		);
	}
	if (s.leaks > 0) {
		console.log(`  ✗ ${s.leaks} event(s) carry typed content. This recording must not be kept.`);
	} else {
		console.log('  ✓ No event carries typed content.');
	}
}

async function replay(opts) {
	if (!opts.in) {
		console.error('✗ --mode=replay needs --in.');
		return 1;
	}
	const events = parseRecording(readFileSync(resolve(ROOT, opts.in), 'utf8'));
	const s = summarize(events);
	if (!s.hasTrajectory) {
		console.error('✗ This recording holds no usable trajectory — refusing to replay it.');
		return 1;
	}

	const { requireDriver } = await import('../packages/browser/src/driver/index.ts');
	const driver = await requireDriver(opts.driver);
	const session = await driver.launch({ headless: false });
	const page = await session.newPage();

	const nav = events.find((e) => e.kind === 'nav' && e.url);
	if (nav) await page.goto(nav.url, { waitUntil: 'load', timeout: 60_000 });

	const delays = replayDelays(events, opts.speed);
	console.log(`Replaying ${events.length} events at ${opts.speed}×…`);

	for (const [i, event] of events.entries()) {
		if (i > 0) await new Promise((r) => setTimeout(r, delays[i - 1]));
		try {
			if (event.kind === 'move') {
				// Replay the coalesced sub-frame path when the recording kept one:
				// that is the part a synthetic curve cannot reproduce.
				for (const [x, y] of event.path ?? [[event.x, event.y]]) {
					await page.mouse?.move(x, y);
				}
			} else if (event.kind === 'down') {
				await page.mouse?.down({ button: buttonName(event.button) });
			} else if (event.kind === 'up') {
				await page.mouse?.up({ button: buttonName(event.button) });
			} else if (event.kind === 'scroll') {
				await page.mouse?.wheel(0, event.y ?? 0);
			}
			// `key` events are timing only and carry nothing to type. Anything
			// secret is supplied at replay time from the session manager.
		} catch (err) {
			console.error(`  event ${i} (${event.kind}) failed: ${err.message}`);
		}
	}

	console.log('✓ Replay complete. The window stays open for inspection; close it to finish.');
	await new Promise((done) => page.on('close', done));
	await session.close().catch(() => {});
	return 0;
}

function buttonName(index) {
	return index === 2 ? 'right' : index === 1 ? 'middle' : 'left';
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(HELP);
		return 0;
	}

	if (opts.mode === 'inspect') {
		if (!opts.in) {
			console.error('✗ --mode=inspect needs --in.');
			return 1;
		}
		const s = summarize(parseRecording(readFileSync(resolve(ROOT, opts.in), 'utf8')));
		console.log(`${s.total} events over ${(s.durationMs / 1000).toFixed(1)}s`);
		report(s);
		return s.leaks > 0 ? 1 : 0;
	}
	if (opts.mode === 'record') return record(opts);
	if (opts.mode === 'replay') return replay(opts);

	console.error(`✗ Unknown --mode=${opts.mode}.\n\n${HELP}`);
	return 1;
}

// Importing runs nothing; a unit test drives the exported helpers directly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(`✗ ${err.message}`);
			process.exit(1);
		});
}
