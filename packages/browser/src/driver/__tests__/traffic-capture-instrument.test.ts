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
 * The two halves reach that world differently, and the difference is deliberate.
 * Install goes through the main-world bridge, which appends a <script>. Drain
 * must not: a `script-src` policy refuses an injected tag, and a great many real
 * sites ship one, so a drain that needed injection would report an instrumented
 * page as a page that made no calls. Instead the instrument listens for a DOM
 * event and answers on the shared DOM, which crosses the boundary without
 * injecting anything — so drain is an ordinary evaluate.
 *
 * From Node there is no assertion for "ran in the main world", so these pin the
 * observable proxy: only the bridge calls `waitForFunction`. Install must call
 * it; drain must not.
 */

import { describe, expect, it, vi } from 'vitest';
import { isEngineInternal } from '../capture-filter.js';
import {
	drainEgressEvents,
	installEgressInstrument,
	startTrafficCapture,
} from '../traffic-capture.js';
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

	/** A frame double whose evaluate answers with whatever the drain would find. */
	function frame(result: unknown, over: Record<string, unknown> = {}) {
		const seen = { evaluate: 0, waitForFunction: 0 };
		return Object.assign(
			{
				evaluate: vi.fn(async () => {
					seen.evaluate += 1;
					return result;
				}),
				waitForFunction: vi.fn(async () => {
					seen.waitForFunction += 1;
				}),
				seen,
			},
			over,
		) as unknown as DriverPage & { seen: typeof seen };
	}

	it('reads the buffer with an ordinary evaluate', async () => {
		const page = frame([event]);
		expect(await drainEgressEvents(page)).toEqual([event]);
	});

	// The reason drain does not use the bridge: injection is what CSP refuses.
	it('never injects a script, so a strict script-src cannot silence it', async () => {
		const page = frame([event]);
		await drainEgressEvents(page);
		expect(page.seen.waitForFunction).toBe(0);
		expect(page.seen.evaluate).toBeGreaterThan(0);
	});

	// An iframe has its own global, and an embedded player is exactly where a
	// transport hides — draining only the main frame reports it as absent.
	it('drains every frame, not only the main one', async () => {
		const frames = [frame([event]), frame([{ ...event, url: 'https://y.test/b' }])];
		const page = frame([], { frames: () => frames });
		const out = await drainEgressEvents(page);
		expect(out.map((e) => e.url)).toEqual(['https://x.test/a', 'https://y.test/b']);
	});

	it('keeps the frames that answered when one refuses', async () => {
		const good = frame([event]);
		const bad = frame(null, {
			evaluate: vi.fn(async () => {
				throw new Error('detached frame');
			}),
		});
		const page = frame([], { frames: () => [bad, good] });
		expect(await drainEgressEvents(page)).toEqual([event]);
	});

	it('returns nothing rather than throwing when a frame answers with a non-array', async () => {
		expect(await drainEgressEvents(frame({ not: 'an array' }))).toEqual([]);
	});
});

describe('document capture', () => {
	/** A response double shaped like Playwright's, for the listener under test. */
	function pageWithResponse(resourceType, contentType, body = '<html>ok</html>') {
		const captured = [];
		let handler = null;
		const page = {
			on: (event, fn) => {
				if (event === 'response') handler = fn;
			},
			context: () => null,
		};
		const response = {
			url: () => 'https://x.test/page',
			status: () => 200,
			headers: () => ({ 'content-type': contentType }),
			allHeaders: async () => ({ 'content-type': contentType }),
			body: async () => Buffer.from(body),
			request: () => ({
				url: () => 'https://x.test/page',
				method: () => 'GET',
				resourceType: () => resourceType,
				postData: () => null,
				headers: () => ({}),
				allHeaders: async () => ({}),
			}),
		};
		return { page, captured, fire: async () => handler && (await handler(response)) };
	}

	// Pre-hydration HTML is where server-rendered data lives, and the data filter
	// deliberately drops markup on the XHR path. Both are correct, so a document
	// needs its own route rather than a hole in the filter.
	it('captures a document under its own marker, past the data filter', async () => {
		const h = pageWithResponse('document', 'text/html; charset=utf-8');
		startTrafficCapture(h.page, (req, res) => h.captured.push({ req, res }));
		await h.fire();
		expect(h.captured).toHaveLength(1);
		expect(h.captured[0].req.method).toBe('DOCUMENT');
		expect(h.captured[0].res.body).toContain('ok');
	});

	// An HTML body on the XHR path is an error page or a challenge, not a result.
	it('still drops markup that arrives on the XHR path', async () => {
		const h = pageWithResponse('xhr', 'text/html');
		startTrafficCapture(h.page, (req, res) => h.captured.push({ req, res }));
		await h.fire();
		expect(h.captured).toHaveLength(0);
	});

	it('captures JSON on the XHR path as before', async () => {
		const h = pageWithResponse('xhr', 'application/json', '{"a":1}');
		startTrafficCapture(h.page, (req, res) => h.captured.push({ req, res }));
		await h.fire();
		expect(h.captured).toHaveLength(1);
		expect(h.captured[0].req.method).toBe('GET');
	});

	it('skips a document whose body cannot be read rather than recording an empty one', async () => {
		const h = pageWithResponse('document', 'text/html');
		startTrafficCapture(h.page, (req, res) => h.captured.push({ req, res }));
		h.page.on = (event, fn) => {
			if (event === 'response')
				h.fire = async () =>
					fn({
						...(await Promise.resolve({})),
						url: () => 'https://x.test/p',
						status: () => 200,
						headers: () => ({}),
						allHeaders: async () => ({}),
						body: async () => {
							throw new Error('cache hit');
						},
						request: () => ({
							url: () => 'https://x.test/p',
							method: () => 'GET',
							resourceType: () => 'document',
							postData: () => null,
							headers: () => ({}),
							allHeaders: async () => ({}),
						}),
					});
		};
		startTrafficCapture(h.page, (req, res) => h.captured.push({ req, res }));
		await h.fire();
		expect(h.captured).toHaveLength(0);
	});
});

describe('engine plumbing is not site traffic', () => {
	// The document path deliberately bypasses the data-content-type filter, so
	// anything excluded only by that filter comes back. The engine's own
	// injection URL is a document, so it arrived as a captured page of the site.
	it.each([
		'http://patchright-init-script-inject.internal/',
		'about:blank',
		'http://playwright-init-script.internal/x',
	])('drops %s', (url) => {
		expect(isEngineInternal(url)).toBe(true);
	});

	it.each([
		'https://x.test/page',
		'http://localhost:4444/sites/newsboard/',
	])('keeps the real page %s', (url) => {
		expect(isEngineInternal(url)).toBe(false);
	});
});

describe('binary WebSocket frames survive the wire path', () => {
	/** A socket double shaped like Playwright's. */
	function socketPage() {
		const captured = [];
		const handlers = {};
		const ws = {
			url: () => 'wss://x.test/stream',
			on: (event, fn) => {
				handlers[event] = fn;
			},
		};
		const page = {
			on: (event, fn) => {
				if (event === 'websocket') fn(ws);
			},
			context: () => null,
		};
		startTrafficCapture(page, (req, res) => captured.push({ req, res }));
		return { captured, frame: (payload) => handlers.framereceived(payload) };
	}

	// Decoding protobuf as utf8 yields replacement characters and destroys the
	// payload, so the socket carrying the most interesting data on a site reads
	// as a socket carrying noise — and the row gets written off as empty.
	it('keeps a binary frame decodable as base64', () => {
		const h = socketPage();
		h.frame(Buffer.from([8, 150, 1]));
		const body = h.captured.find((c) => c.res.body?.type === 'websocket-frame')?.res.body;
		expect(body.encoding).toBe('base64');
		expect(body.data).toBe(Buffer.from([8, 150, 1]).toString('base64'));
		expect(body.size).toBe(3);
	});

	it('leaves a text frame as text', () => {
		const h = socketPage();
		h.frame('{"tick":1}');
		const body = h.captured.find((c) => c.res.body?.type === 'websocket-frame')?.res.body;
		expect(body.encoding).toBe('utf8');
		expect(body.data).toEqual({ tick: 1 });
	});

	// A reader cannot tell base64 from text by looking, and guessing wrong either
	// mangles a payload or decodes one that was never encoded.
	it('states the encoding rather than leaving it to be inferred', () => {
		const h = socketPage();
		h.frame(Buffer.from('not really text', 'binary'));
		const body = h.captured.find((c) => c.res.body?.type === 'websocket-frame')?.res.body;
		expect(body).toHaveProperty('encoding');
	});
});
