/**
 * Pins the world the instrument installs into, and the world the drain reads
 * from.
 *
 * Both must be the page's own. An isolated-world `evaluate` shares the DOM and
 * nothing else, so patching `fetch` there yields a wrapper the page never calls
 * and reading the buffer there finds a `globalThis` that never had one. Neither
 * throws. The instrument reports installed, the drain reports zero events, and
 * the run concludes the site makes no calls — the exact quiet failure this
 * capture layer exists to remove.
 *
 * There is no assertion available for "ran in the main world" from Node, so
 * these pin the observable proxy: only the main-world bridge calls
 * `waitForFunction`, because only it waits on a DOM handshake. A refactor back
 * to a plain `evaluate` stops calling it and turns these red.
 */

import { describe, expect, it, vi } from 'vitest';
import { drainEgressEvents, installEgressInstrument } from '../traffic-capture.js';
import type { DriverPage } from '../types.js';

/**
 * A page double standing in for the isolated/main world split: `evaluate` is
 * the isolated world and answers with a global that does not exist there, while
 * the bridge's DOM handshake is satisfied by `waitForFunction` returning the
 * envelope the bridge expects.
 */
function bridgePage(envelope: unknown, over: Record<string, unknown> = {}) {
	const seen = { evaluate: 0, waitForFunction: 0, addInitScript: 0 };
	const page = {
		// The bridge evaluates twice: once with an injection payload object, once
		// with the marker string to read the result attribute back. Only the second
		// returns anything, which is what makes the two distinguishable here.
		evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
			seen.evaluate += 1;
			if (typeof arg === 'string') return JSON.stringify({ ok: true, value: envelope });
			return undefined;
		}),
		waitForFunction: vi.fn(async () => {
			seen.waitForFunction += 1;
		}),
		addInitScript: vi.fn(async () => {
			seen.addInitScript += 1;
		}),
		seen,
		...over,
	};
	return page as unknown as DriverPage & { seen: typeof seen };
}

describe('installEgressInstrument', () => {
	it('registers an init script so startup calls are not missed', async () => {
		const page = bridgePage(true);
		await installEgressInstrument(page);
		expect(page.seen.addInitScript).toBe(1);
	});

	// The already-loaded document missed the init hook. Catching it up through a
	// plain evaluate would patch a world the page never uses.
	it('catches the current document up through the main-world bridge', async () => {
		const page = bridgePage(true);
		await installEgressInstrument(page);
		expect(page.seen.waitForFunction).toBeGreaterThan(0);
	});

	it('still reports installed when only the init script path works', async () => {
		const page = bridgePage(true, {
			waitForFunction: vi.fn(async () => {
				throw new Error('CSP blocked the injected tag');
			}),
		});
		expect(await installEgressInstrument(page)).toBe(true);
	});

	it('still reports installed when only the catch-up path works', async () => {
		const page = bridgePage(true, {
			addInitScript: vi.fn(async () => {
				throw new Error('engine has no addInitScript');
			}),
		});
		expect(await installEgressInstrument(page)).toBe(true);
	});

	// Reporting installed when nothing was would send a run into capture that
	// silently returns nothing.
	it('reports failure when neither path works', async () => {
		const page = bridgePage(true, {
			addInitScript: vi.fn(async () => {
				throw new Error('no');
			}),
			waitForFunction: vi.fn(async () => {
				throw new Error('no');
			}),
		});
		expect(await installEgressInstrument(page)).toBe(false);
	});
});

describe('drainEgressEvents', () => {
	const event = { kind: 'fetch', method: 'GET', url: 'https://x.test/a', t: 1 };

	it('reads the buffer through the bridge, not the isolated world', async () => {
		const page = bridgePage([event]);
		const out = await drainEgressEvents(page);
		expect(out).toEqual([event]);
		expect(page.seen.waitForFunction).toBeGreaterThan(0);
	});

	// An iframe has its own global, and an embedded player is exactly where a
	// transport hides — draining only the main frame reports it as absent.
	it('drains every frame, not only the main one', async () => {
		const frames = [bridgePage([event]), bridgePage([{ ...event, url: 'https://y.test/b' }])];
		const page = bridgePage([], { frames: () => frames });
		const out = await drainEgressEvents(page);
		expect(out.map((e) => e.url)).toEqual(['https://x.test/a', 'https://y.test/b']);
	});

	it('keeps the frames that answered when one refuses', async () => {
		const good = bridgePage([event]);
		const bad = bridgePage(null, {
			waitForFunction: vi.fn(async () => {
				throw new Error('detached frame');
			}),
		});
		const page = bridgePage([], { frames: () => [bad, good] });
		expect(await drainEgressEvents(page)).toEqual([event]);
	});

	it('returns nothing rather than throwing when a frame answers with a non-array', async () => {
		const page = bridgePage({ not: 'an array' });
		expect(await drainEgressEvents(page)).toEqual([]);
	});
});
