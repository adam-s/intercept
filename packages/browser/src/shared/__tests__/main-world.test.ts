/**
 * Pins the main-world bridge protocol.
 *
 * The fake page below models the property that makes the bridge necessary: two
 * JavaScript worlds that share a DOM but not their globals. `evaluate` runs in
 * the isolated world; an injected `<script>` runs in the main world. That split
 * was verified empirically against Patchright + the test server on 2026-07-28
 * (see the module docblock); this suite pins the protocol built on top of it.
 */

import { describe, expect, it, vi } from 'vitest';
import { evaluateInMainWorld, type MainWorldPage } from '../main-world.js';

/**
 * A two-world page double.
 *
 * `mainWorldGlobals` is reachable only from injected script text; the isolated
 * world sees `isolatedGlobals`. Attributes are shared, which is exactly the
 * channel the bridge uses.
 */
function fakePage(
	options: { mainWorldGlobals?: Record<string, unknown>; refuseScripts?: boolean } = {},
) {
	const attributes = new Map<string, string>();
	const mainWorldGlobals = options.mainWorldGlobals ?? {};

	const documentElement = {
		appendChild(script: { textContent: string }) {
			if (options.refuseScripts) return; // models a script-src CSP refusing the tag
			// The main world evaluates the script text with its own globals in scope.
			const run = new Function(
				'window',
				'document',
				`return (async () => { ${script.textContent} })();`,
			);
			run(mainWorldGlobals, { documentElement });
		},
		setAttribute: (k: string, v: string) => void attributes.set(k, v),
		getAttribute: (k: string) => attributes.get(k) ?? null,
		removeAttribute: (k: string) => void attributes.delete(k),
		hasAttribute: (k: string) => attributes.has(k),
	};

	// Real page.evaluate serializes the function and runs it in the page, so the
	// double must too — calling it directly would let it close over the test's
	// scope and hide the very isolation being modelled.
	const isolatedDocument = {
		documentElement,
		createElement: () => ({ textContent: '', remove() {} }),
	};
	const runIsolated = (fn: (arg: never) => unknown, arg: unknown) =>
		new Function('document', 'arg', `return (${fn.toString()})(arg);`)(isolatedDocument, arg);

	const page: MainWorldPage = {
		// The isolated world: the DOM is shared, page globals are not.
		async evaluate(fn: (arg: never) => unknown, arg: unknown) {
			return runIsolated(fn, arg) as never;
		},
		async waitForFunction(fn: (arg: never) => unknown, arg: unknown, opts?: { timeout?: number }) {
			for (let i = 0; i < 50; i++) {
				if (runIsolated(fn, arg)) return true;
				await new Promise((r) => setTimeout(r, 1));
			}
			throw new Error(`timeout after ${opts?.timeout ?? 0}ms`);
		},
	};

	return { page, attributes };
}

describe('evaluateInMainWorld', () => {
	it('reads a page global the isolated world cannot see', async () => {
		const { page } = fakePage({ mainWorldGlobals: { __INITIAL_STATE__: { user: 'ada' } } });

		// The isolated world sees nothing — this is the failure the bridge exists for.
		const isolated = await page.evaluate(
			() => (globalThis as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__,
			undefined,
		);
		expect(isolated).toBeUndefined();

		const viaBridge = await evaluateInMainWorld(page, () => window.__INITIAL_STATE__);
		expect(viaBridge).toEqual({ user: 'ada' });
	});

	it('passes an argument through and returns the result', async () => {
		const { page } = fakePage({ mainWorldGlobals: { factor: 3 } });
		const result = await evaluateInMainWorld(page, (n: number) => window.factor * n, 7);
		expect(result).toBe(21);
	});

	it('awaits an async page function', async () => {
		const { page } = fakePage({
			mainWorldGlobals: { mint: () => Promise.resolve('tok_123') },
		});
		expect(await evaluateInMainWorld(page, async () => await window.mint())).toBe('tok_123');
	});

	it('propagates an error thrown in the page rather than returning undefined', async () => {
		const { page } = fakePage();
		await expect(
			evaluateInMainWorld(page, () => {
				throw new Error('widget not found');
			}),
		).rejects.toThrow('widget not found');
	});

	it('normalizes an undefined return to null instead of hanging', async () => {
		const { page } = fakePage();
		expect(await evaluateInMainWorld(page, () => undefined)).toBeNull();
	});

	it('names the CSP possibility when the page never reports back', async () => {
		const { page } = fakePage({ refuseScripts: true });
		await expect(evaluateInMainWorld(page, () => 1, undefined, { timeout: 20 })).rejects.toThrow(
			/Content-Security-Policy/,
		);
	});

	it('cleans up its marker attribute so repeated calls cannot read a stale result', async () => {
		const { page, attributes } = fakePage({ mainWorldGlobals: { v: 1 } });
		await evaluateInMainWorld(page, () => window.v);
		expect(attributes.size).toBe(0);
	});

	it('uses a distinct marker per call so concurrent evaluations do not collide', async () => {
		const { page } = fakePage({ mainWorldGlobals: { a: 'first', b: 'second' } });
		const [a, b] = await Promise.all([
			evaluateInMainWorld(page, () => window.a),
			evaluateInMainWorld(page, () => window.b),
		]);
		expect([a, b]).toEqual(['first', 'second']);
	});
});

declare global {
	interface Window {
		__INITIAL_STATE__?: unknown;
		factor: number;
		mint: () => Promise<string>;
		v: number;
		a: string;
		b: string;
	}
}
