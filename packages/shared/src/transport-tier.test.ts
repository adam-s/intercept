import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimitedFetch, registerRateLimit } from './rate-limiter.js';
import {
	assertNotChallenge,
	assertOpenTransport,
	clearTransportTiers,
	detectChallenge,
	getTransportTier,
	getTransportTiers,
	registerTransportTier,
	TransportTierError,
} from './transport-tier.js';

/** A Response with the given headers/status and a body that must never be read. */
function responseWith(status: number, headers: Record<string, string>): Response {
	return new Response('<html>challenge</html>', { status, headers });
}

beforeEach(() => {
	clearTransportTiers();
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearTransportTiers();
});

describe('tier registry', () => {
	it('defaults unregistered hosts to open', () => {
		expect(getTransportTier('https://unknown.example.com/x')).toBe('open');
	});

	it('records and reports registered tiers', () => {
		registerTransportTier('gated.example.com', 'session-gated');
		registerTransportTier('open.example.com', 'open');
		expect(getTransportTier('https://gated.example.com/a/b?c=1')).toBe('session-gated');
		expect(getTransportTiers()).toEqual({
			'gated.example.com': 'session-gated',
			'open.example.com': 'open',
		});
	});

	it('re-registering replaces the tier, so a re-run elimination takes effect', () => {
		registerTransportTier('host.example.com', 'session-gated');
		registerTransportTier('host.example.com', 'open');
		expect(() => assertOpenTransport('https://host.example.com/x')).not.toThrow();
	});

	it('treats an unparseable URL as open rather than throwing', () => {
		expect(getTransportTier('not a url')).toBe('open');
	});
});

describe('assertOpenTransport', () => {
	it('throws TransportTierError for a session-gated host', () => {
		registerTransportTier('gated.example.com', 'session-gated');
		try {
			assertOpenTransport('https://gated.example.com/items');
			expect.unreachable('expected a TransportTierError');
		} catch (err) {
			expect(err).toBeInstanceOf(TransportTierError);
			const e = err as TransportTierError;
			expect(e.violation).toBe('session-gated-over-http');
			expect(e.url).toBe('https://gated.example.com/items');
			expect(e.message).toContain('browserFetch');
		}
	});

	it('passes an open host through', () => {
		registerTransportTier('open.example.com', 'open');
		expect(() => assertOpenTransport('https://open.example.com/items')).not.toThrow();
	});

	it('gates by host, not by path', () => {
		registerTransportTier('gated.example.com', 'session-gated');
		expect(() => assertOpenTransport('https://gated.example.com/')).toThrow(TransportTierError);
		expect(() => assertOpenTransport('https://other.example.com/')).not.toThrow();
	});
});

describe('detectChallenge', () => {
	const cases: Array<[string, number, Record<string, string>, string | null]> = [
		['cloudflare states the mitigation', 200, { 'cf-mitigated': 'challenge' }, 'cloudflare'],
		['cloudflare edge block', 403, { 'cf-ray': 'abc123', server: 'cloudflare' }, 'cloudflare'],
		['cloudflare edge 503 challenge', 503, { 'cf-ray': 'abc123' }, 'cloudflare'],
		['datadome response header', 403, { 'x-datadome': 'protected' }, 'datadome'],
		['datadome first-block cookie', 403, { 'set-cookie': 'datadome=abc; Path=/' }, 'datadome'],
		['akamai bot manager', 403, { server: 'AkamaiGHost' }, 'akamai'],
		['kasada sdk headers', 429, { 'x-kpsdk-cd': '{}' }, 'kasada'],
		['perimeterx block', 403, { 'x-px-block': '1' }, 'perimeterx'],
	];

	it.each(cases)('flags %s', (_name, status, headers, expected) => {
		expect(detectChallenge(new Headers(headers), status)).toBe(expected);
	});

	// The narrowness is the contract: widening the signature list changes the
	// behavior of every existing route, so these negatives are load-bearing.
	const passthrough: Array<[string, number, Record<string, string>]> = [
		['an ordinary 403 from a cooperating API', 403, { 'content-type': 'application/json' }],
		['an ordinary 429 with no WAF marker', 429, { 'retry-after': '30' }],
		['a Cloudflare-fronted origin serving real data', 200, { 'cf-ray': 'abc123' }],
		['a Cloudflare-fronted origin 404', 404, { 'cf-ray': 'abc123' }],
		['a plain HTML page', 200, { 'content-type': 'text/html' }],
		['an Akamai-fronted origin serving real data', 200, { server: 'AkamaiGHost' }],
	];

	it.each(passthrough)('passes %s through', (_name, status, headers) => {
		expect(detectChallenge(new Headers(headers), status)).toBeNull();
	});
});

describe('assertNotChallenge', () => {
	it('throws with the vendor and status attached', () => {
		try {
			assertNotChallenge(responseWith(403, { 'cf-ray': 'r1' }), 'https://x.example.com/api');
			expect.unreachable('expected a TransportTierError');
		} catch (err) {
			const e = err as TransportTierError;
			expect(e).toBeInstanceOf(TransportTierError);
			expect(e.violation).toBe('challenge-response');
			expect(e.vendor).toBe('cloudflare');
			expect(e.status).toBe(403);
		}
	});

	it('leaves the body unread so the caller keeps its stream', () => {
		const res = responseWith(200, { 'content-type': 'application/json' });
		assertNotChallenge(res, 'https://x.example.com/api');
		expect(res.bodyUsed).toBe(false);
	});
});

describe('rateLimitedFetch enforces the ladder', () => {
	it('refuses a session-gated host before any network call', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		registerTransportTier('gated.example.com', 'session-gated');

		await expect(rateLimitedFetch('https://gated.example.com/items')).rejects.toBeInstanceOf(
			TransportTierError,
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('refuses a challenge response rather than returning it as data', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => responseWith(403, { 'cf-ray': 'r1' })),
		);

		await expect(rateLimitedFetch('https://waf.example.com/api')).rejects.toBeInstanceOf(
			TransportTierError,
		);
	});

	it('returns the challenge response when the caller opts in to escalate', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => responseWith(403, { 'cf-ray': 'r1' })),
		);

		const res = await rateLimitedFetch('https://waf.example.com/api', {
			allowChallengeResponse: true,
		});
		expect(res.status).toBe(403);
	});

	it('strips allowChallengeResponse before it reaches fetch', async () => {
		const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchSpy);

		await rateLimitedFetch('https://plain.example.com/api', {
			method: 'POST',
			allowChallengeResponse: true,
		});

		const init = fetchSpy.mock.calls[0][1] as Record<string, unknown>;
		expect(init.method).toBe('POST');
		expect(init).not.toHaveProperty('allowChallengeResponse');
	});

	it('still guards the rate-limited path, not only the passthrough path', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => responseWith(403, { server: 'AkamaiGHost' })),
		);
		registerRateLimit('limited.example.com', { maxPerMinute: 10, retryOn429: 0 });

		await expect(rateLimitedFetch('https://limited.example.com/api')).rejects.toBeInstanceOf(
			TransportTierError,
		);
	});

	it('leaves ordinary non-2xx responses alone', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 403 })),
		);

		const res = await rateLimitedFetch('https://plain.example.com/api');
		expect(res.status).toBe(403);
	});
});
