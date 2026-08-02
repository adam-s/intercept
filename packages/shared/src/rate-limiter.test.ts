import { describe, expect, it } from 'vitest';
import {
	recordRateLimitedRequest,
	registerRateLimit,
	releaseRateLimitSlot,
	waitForRateLimitSlot,
} from './rate-limiter.js';

/** One acquire/record/release cycle, returning when it was admitted. */
async function admit(url: string): Promise<number> {
	await waitForRateLimitSlot(url);
	recordRateLimitedRequest(url);
	const at = Date.now();
	releaseRateLimitSlot(url);
	return at;
}

describe('minSpacingMs', () => {
	it('spaces successive requests, which a per-minute count alone does not', async () => {
		const host = 'spaced.example.invalid';
		const url = `https://${host}/page`;
		// A budget nowhere near exhausted by three calls: without spacing all
		// three are admitted at once, which is the burst a small origin refuses.
		registerRateLimit(host, { maxPerMinute: 60, maxConcurrent: 1, minSpacingMs: 300 });

		const first = await admit(url);
		const second = await admit(url);
		const third = await admit(url);

		expect(second - first).toBeGreaterThanOrEqual(280);
		expect(third - second).toBeGreaterThanOrEqual(280);
	}, 10_000);

	it('leaves an unspaced host on the fast path', async () => {
		const host = 'unspaced.example.invalid';
		const url = `https://${host}/page`;
		registerRateLimit(host, { maxPerMinute: 60, maxConcurrent: 1 });

		const started = Date.now();
		await admit(url);
		await admit(url);
		await admit(url);

		expect(Date.now() - started).toBeLessThan(250);
	}, 10_000);
});
