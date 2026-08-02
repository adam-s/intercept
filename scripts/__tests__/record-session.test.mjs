/**
 * Unit pins for record-session's pure helpers, and for the guarantee the whole
 * tool rests on: a recording cannot carry what was typed.
 */

import { describe, expect, it } from 'vitest';
import {
	EVENT_KINDS,
	isContentBearing,
	parseArgs,
	parseRecording,
	redact,
	replayDelays,
	summarize,
} from '../record-session.mjs';

describe('parseArgs', () => {
	it('defaults to inspect, so a bare run cannot open a browser', () => {
		expect(parseArgs([])).toMatchObject({ mode: 'inspect', driver: 'patchright', speed: 1 });
	});

	it('reads the uniform flags', () => {
		expect(
			parseArgs(['--mode=record', '--url=https://x.test/a?b=1', '--out=data/recordings/x.jsonl']),
		).toMatchObject({
			mode: 'record',
			url: 'https://x.test/a?b=1',
			out: 'data/recordings/x.jsonl',
		});
	});
});

// The tool's central promise. If these fail, a recording could hold a password.
describe('typed content never reaches a recording', () => {
	it.each(['value', 'text', 'code', 'key'])('strips "%s" from a key event', (field) => {
		const out = redact({ kind: 'key', t: 10, [field]: 'hunter2' });
		expect(out).not.toHaveProperty(field);
		expect(JSON.stringify(out)).not.toContain('hunter2');
	});

	it('keeps the timing, which is what replay actually needs', () => {
		expect(redact({ kind: 'key', t: 1234, key: 'a' })).toEqual({ kind: 'key', t: 1234 });
	});

	it('leaves non-key events untouched', () => {
		const move = { kind: 'move', x: 1, y: 2, t: 3, path: [[1, 2, 3]] };
		expect(redact(move)).toEqual(move);
	});

	it('detects a content-bearing event so a summary can refuse it', () => {
		expect(isContentBearing({ kind: 'key', t: 1, key: 'a' })).toBe(true);
		expect(isContentBearing({ kind: 'key', t: 1 })).toBe(false);
		expect(isContentBearing({ kind: 'move', x: 1, y: 2, t: 1 })).toBe(false);
	});

	it('reports a leak in the summary rather than passing silently', () => {
		const s = summarize([
			{ kind: 'key', t: 1, key: 'a' },
			{ kind: 'key', t: 2 },
		]);
		expect(s.leaks).toBe(1);
	});

	it('redaction survives a round trip through the log format', () => {
		const line = JSON.stringify(redact({ kind: 'key', t: 5, key: 'p', value: 'secret' }));
		expect(parseRecording(line)[0]).toEqual({ kind: 'key', t: 5 });
	});
});

describe('parseRecording', () => {
	it('reads JSONL and skips blank lines', () => {
		expect(parseRecording('{"kind":"move","t":1}\n\n{"kind":"down","t":2}\n')).toHaveLength(2);
	});

	// A truncated recording read as an empty one would look like "the human did
	// nothing" instead of "the file is broken".
	it('throws with the line number on malformed input', () => {
		expect(() => parseRecording('{"kind":"move"}\n{oops\n')).toThrow(/line 2/);
	});

	it('returns nothing for an empty file', () => {
		expect(parseRecording('')).toEqual([]);
	});
});

describe('summarize', () => {
	const moves = Array.from({ length: 12 }, (_, i) => ({ kind: 'move', x: i, y: i, t: i * 10 }));

	it('counts by kind and measures the span', () => {
		const s = summarize([...moves, { kind: 'down', t: 200 }]);
		expect(s.total).toBe(13);
		expect(s.byKind.move).toBe(12);
		expect(s.byKind.down).toBe(1);
		expect(s.durationMs).toBe(200);
	});

	// Replaying a trajectory-free recording produces exactly the straight-line
	// motion the tool exists to avoid, so this gates replay.
	it('flags a recording with too few moves to hold a trajectory', () => {
		expect(summarize(moves).hasTrajectory).toBe(true);
		expect(summarize(moves.slice(0, 3)).hasTrajectory).toBe(false);
		expect(summarize([]).hasTrajectory).toBe(false);
	});

	it('handles a recording with no timestamps without producing NaN', () => {
		expect(summarize([{ kind: 'move' }, { kind: 'move' }]).durationMs).toBe(0);
	});
});

describe('replayDelays', () => {
	it('reproduces the recording own intervals', () => {
		expect(replayDelays([{ t: 0 }, { t: 100 }, { t: 250 }])).toEqual([100, 150]);
	});

	it('scales the whole timeline by speed', () => {
		expect(replayDelays([{ t: 0 }, { t: 100 }], 2)).toEqual([50]);
	});

	// A clock that ran backwards is noise; a negative delay would throw at the
	// timer rather than degrade.
	it('clamps a backwards interval to zero', () => {
		expect(replayDelays([{ t: 100 }, { t: 50 }])).toEqual([0]);
	});

	it('ignores a nonsensical speed rather than dividing by zero', () => {
		expect(replayDelays([{ t: 0 }, { t: 100 }], 0)).toEqual([100]);
		expect(replayDelays([{ t: 0 }, { t: 100 }], -1)).toEqual([100]);
	});

	it('returns nothing for a single event', () => {
		expect(replayDelays([{ t: 0 }])).toEqual([]);
	});
});

describe('event kinds', () => {
	it('names every kind the capture code emits', () => {
		for (const k of ['move', 'down', 'up', 'scroll', 'key', 'focus']) {
			expect(EVENT_KINDS).toContain(k);
		}
	});
});
