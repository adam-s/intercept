/**
 * Pins for the capture benchmark.
 *
 * The bench measures recall by comparing what the capture recovered against
 * what this page declares it emits. That comparison is only meaningful while
 * the declaration matches the page: a fixture that quietly stopped calling
 * `sendBeacon` while still claiming Beacon/Telemetry turns a real capture
 * regression into a green run, and a declaration naming a transport the
 * elimination table has never heard of scores against a row that cannot exist.
 *
 * Both are checked here, without a browser, so a broken bench fails in CI
 * rather than during the run it was supposed to measure.
 */

import { describe, expect, it } from 'vitest';
import { OBSERVABLE_TRANSPORTS } from '../../../browser/src/driver/manifest.js';
import { createTestServer } from '../index';
import {
	BENCHMARK_PRIMITIVES,
	BENCHMARK_TRANSPORTS,
	createBenchmarkSite,
} from '../sites/benchmark';

const app = createBenchmarkSite();
const page = await (await app.request('/')).text();

describe('the answer key matches the page', () => {
	it('declares a primitive for every transport it claims', () => {
		const undeclared = BENCHMARK_TRANSPORTS.filter((t) => !BENCHMARK_PRIMITIVES[t]);
		expect(undeclared).toEqual([]);
	});

	// The failure this exists for: a fixture that stops exercising something it
	// still claims turns a capture regression into a passing measurement.
	it.each(BENCHMARK_TRANSPORTS)('actually reaches for %s', (transport) => {
		expect(page).toContain(BENCHMARK_PRIMITIVES[transport]);
	});

	it('claims nothing the elimination table cannot name', () => {
		const unknown = BENCHMARK_TRANSPORTS.filter((t) => !OBSERVABLE_TRANSPORTS.includes(t));
		expect(unknown).toEqual([]);
	});

	// A bench covering half the table would report high recall while leaving the
	// untested half free to break.
	it('covers all but the transports no page can emit on demand', () => {
		const uncovered = OBSERVABLE_TRANSPORTS.filter(
			(t) => !(BENCHMARK_TRANSPORTS as readonly string[]).includes(t),
		);
		expect(uncovered).toEqual([]);
	});
});

describe('the page runs its calls without an interaction', () => {
	it('exercises every primitive on load, so recall does not depend on the sweep', () => {
		expect(page).toMatch(/<script>[\s\S]*\(\(\) => \{[\s\S]*\}\)\(\);[\s\S]*<\/script>/);
	});

	// One unsupported primitive must not stop the calls after it, or a capture
	// gap and a fixture bug become indistinguishable.
	it('guards each call so an unsupported one cannot halt the rest', () => {
		const attempts = [...page.matchAll(/attempt\('/g)].length;
		expect(attempts).toBeGreaterThanOrEqual(BENCHMARK_TRANSPORTS.length);
		expect(page).toContain('catch (e)');
	});

	// Submitting into the page itself would navigate away mid-measurement.
	it('aims the form at a hidden frame so the page under measurement stays put', () => {
		expect(page).toContain('target="sink"');
	});
});

describe('the endpoints answer', () => {
	it.each([
		['/api/items?page=1', 200],
		['/api/detail/42', 200],
		['/events', 200],
		['/px.gif', 204],
		['/jsonp?callback=onBench', 200],
		['/worker.js', 200],
		['/sw.js', 200],
	])('%s responds %i', async (path, status) => {
		expect((await app.request(path)).status).toBe(status);
	});

	it('serves SSE with the content type that makes it SSE', async () => {
		const res = await app.request('/events');
		expect(res.headers.get('content-type')).toContain('text/event-stream');
	});

	it('answers a GraphQL post with data', async () => {
		const res = await app.request('/graphql', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ query: '{ items { id } }' }),
		});
		expect(await res.json()).toHaveProperty('data.items');
	});

	// The worker's own fetch is invisible to a page-scoped patch; that is the
	// case the Worker-scoped row exists to flag, so the script must really call.
	it('serves a worker that makes its own request', async () => {
		expect(await (await app.request('/worker.js')).text()).toContain('fetch(');
	});
});

// Not about the benchmark, but about the server that serves it: a fixture whose
// routing drops a legitimate request teaches a wrong conclusion. `/x/?q=1`
// 404'd while `/x?q=1` worked, because the trailing-slash normalization tested
// the whole URL and a query string means it never ends with a slash.
describe('the server normalizes a trailing slash even with a query string', () => {
	it.each([
		['/sites/boardshop/?q=deck', 200],
		['/sites/boardshop?q=deck', 200],
		['/sites/boardshop/', 200],
		['/sites/newsboard/?page=2', 200],
	])('%s responds %i', async (path, status) => {
		const server = await createTestServer();
		try {
			const res = await fetch(`${server.url}${path}`);
			expect(res.status).toBe(status);
		} finally {
			await server.close();
		}
	});
});
