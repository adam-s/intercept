/**
 * Main-World Evaluation
 *
 * CORRECTNESS-CRITICAL: `page.evaluate()` under Patchright runs in an
 * **isolated world**. That isolation is the point — it keeps automation
 * artifacts out of the page's own JavaScript context, which is a large part of
 * why Patchright reads as a real browser. The consequence is easy to miss:
 *
 *   The DOM is shared between the two worlds. JavaScript globals are not.
 *
 * So `page.evaluate(() => document.querySelector('...'))` works, while
 * `page.evaluate(() => window.__INITIAL_STATE__)` returns `undefined` — not
 * because the page lacks the global, but because the caller is looking at a
 * different `window`. Nothing throws. The route stores `undefined` and reports
 * success, which is exactly the silent-failure class this framework exists to
 * stop.
 *
 * Verified empirically (2026-07-28) against a page that sets a global from an
 * ordinary `<script src>`: the main world sees the global, `page.evaluate` sees
 * `undefined`, and a global set *by* `page.evaluate` is invisible to the main
 * world. Both directions are isolated.
 *
 * `evaluateInMainWorld` bridges it: it injects a `<script>` element, which the
 * page executes in its own world, and returns the result through a DOM
 * attribute — the one channel both worlds share.
 *
 * Usage:
 *   import { evaluateInMainWorld } from '@interceptor/browser/shared/main-world';
 *
 *   const state = await evaluateInMainWorld(page, () => window.__INITIAL_STATE__);
 *   const token = await evaluateInMainWorld(page, async () => {
 *     const id = window.captchaWidget.render(el, { sitekey });
 *     return await window.captchaWidget.execute(id);
 *   });
 *
 * Constraints, all inherited from the transport being a `<script>` tag:
 *  - The function is serialized to source. It closes over nothing — pass values
 *    via the `arg` parameter, which is JSON-serialized into the script.
 *  - The return value must be JSON-serializable. DOM nodes and functions are
 *    not; return an identifier and re-query instead.
 *  - A page enforcing a script-src Content-Security-Policy will refuse the
 *    injected tag. That surfaces as a timeout, and the thrown error says so.
 *
 * @module browser/shared/main-world
 */

import { DEBUG } from '@interceptor/shared';

/** Minimal surface this module needs, so it doesn't bind to one driver's Page type. */
export interface MainWorldPage {
	evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
	waitForFunction<R, A>(
		fn: (arg: A) => R,
		arg: A,
		options?: { timeout?: number },
	): Promise<unknown>;
}

export interface MainWorldOptions {
	/** How long to wait for the injected script to report back. Default 10000ms. */
	timeout?: number;
}

/** Envelope the injected script writes back through the shared DOM. */
interface Envelope<T> {
	ok: boolean;
	value?: T;
	error?: string;
}

let callCounter = 0;

/**
 * Run a function in the page's own JavaScript world and return its result.
 *
 * Throws when the function throws, when the result is not JSON-serializable, or
 * when the page never reports back within `timeout`.
 */
export async function evaluateInMainWorld<T, A = undefined>(
	page: MainWorldPage,
	fn: (arg: A) => T | Promise<T>,
	arg?: A,
	options: MainWorldOptions = {},
): Promise<T> {
	const timeout = options.timeout ?? 10_000;
	// Unique per call so concurrent evaluations can't read each other's result.
	const marker = `data-mw-${Date.now().toString(36)}-${++callCounter}`;

	const injected = {
		marker,
		source: fn.toString(),
		arg: JSON.stringify(arg ?? null),
	};

	await page.evaluate((payload: typeof injected) => {
		const script = document.createElement('script');
		script.textContent = `(async () => {
			const el = document.documentElement;
			try {
				const result = await (${payload.source})(${payload.arg});
				el.setAttribute(${JSON.stringify(payload.marker)}, JSON.stringify({ ok: true, value: result === undefined ? null : result }));
			} catch (err) {
				el.setAttribute(${JSON.stringify(payload.marker)}, JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
			}
		})();`;
		document.documentElement.appendChild(script);
		script.remove();
	}, injected);

	try {
		await page.waitForFunction((m: string) => document.documentElement.hasAttribute(m), marker, {
			timeout,
		});
	} catch {
		throw new Error(
			`evaluateInMainWorld timed out after ${timeout}ms. The page never reported a result — ` +
				'the function may not have returned, or a script-src Content-Security-Policy refused the injected <script>.',
		);
	}

	const raw = await page.evaluate((m: string) => {
		const value = document.documentElement.getAttribute(m);
		document.documentElement.removeAttribute(m);
		return value;
	}, marker);

	const envelope = JSON.parse(raw as string) as Envelope<T>;
	if (!envelope.ok) {
		throw new Error(`evaluateInMainWorld: page function threw: ${envelope.error}`);
	}

	DEBUG('main-world', `evaluated in page context via ${marker}`);
	return envelope.value as T;
}
