import { describe, expect, it } from 'vitest';
import { createDomainProxy } from '../api-proxy.js';
import type { DomainRoute } from '../domain-loader.js';

/**
 * A handler that rejects must still produce a JSON error response.
 *
 * Regression pin: the proxy used to `return route.handler(...)` without
 * awaiting, so the rejection landed outside the surrounding try/catch and Hono
 * answered with a text/plain 500. A caller doing `.json()` on that gets a parse
 * error instead of a diagnosable failure — and route-spec sees a content-type
 * violation whose real cause is invisible. Found by a discovery agent working
 * on twitch.tv.
 */
describe('domain proxy error handling', () => {
	const routeThatRejects: DomainRoute = {
		method: 'GET',
		path: '/boom',
		browserRequired: false,
		handler: async () => {
			throw new Error('upstream GraphQL error');
		},
	};

	it('returns JSON, not text/plain, when a handler rejects asynchronously', async () => {
		const app = createDomainProxy('testdomain', [routeThatRejects], () => null);
		const res = await app.request('/boom');

		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.headers.get('content-type') ?? '').toMatch(/json/);
		await expect(res.json()).resolves.toBeTypeOf('object');
	});

	it('surfaces the underlying message rather than swallowing it', async () => {
		const app = createDomainProxy('testdomain', [routeThatRejects], () => null);
		const body = (await (await app.request('/boom')).json()) as Record<string, unknown>;
		expect(JSON.stringify(body)).toContain('upstream GraphQL error');
	});
});
