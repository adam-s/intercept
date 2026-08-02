/**
 * Transport Tier Guard
 *
 * The discovery ladder is `browserFetch` → elimination → `rateLimitedFetch`.
 * The last rung is only legitimate once elimination has proved the endpoint
 * needs nothing the browser uniquely carries. Until this module existed that
 * ladder was prose in an instruction file, and prose does not fail a build.
 *
 * Two guards, both loud:
 *
 *  1. **Tier guard.** A host registered `session-gated` refuses to be fetched
 *     over plain Node `fetch`. Node's TLS (JA4) and HTTP/2 (JA4H) fingerprints
 *     are not a browser's, so the request reads as automated no matter how the
 *     headers are dressed. Registering the tier makes the downgrade a
 *     `TransportTierError` at the call site instead of a 403 an hour later.
 *
 *  2. **Challenge guard.** A bot-wall interstitial is not data. Returning one
 *     as a normal `Response` lets a route call `.json()` on a Cloudflare
 *     challenge page and store the result — the silent downgrade this exists to
 *     stop. Detection keys on response headers only, never the body, so it
 *     costs nothing and never consumes a stream.
 *
 * Both are opt-in at the point where knowledge lives: tiers are registered
 * alongside rate limits at startup, and challenge detection only fires on
 * unambiguous WAF signatures.
 *
 * Usage:
 *   import { registerTransportTier, rateLimitedFetch } from '@interceptor/shared';
 *
 *   // At startup, once elimination has recorded what the endpoint needs:
 *   registerTransportTier('api.example.com', 'session-gated');
 *
 *   // In a route handler — now throws instead of returning a challenge page:
 *   const res = await rateLimitedFetch('https://api.example.com/items');
 *
 * @module shared/transport-tier
 */

import { DEBUG } from './debug.js';

// ─── Types ───────────────────────────────────────────────────────────

/**
 * How an endpoint's host must be reached.
 *
 * - `open` — elimination proved no browser-only value is required. Plain HTTP
 *   is correct and fastest. This is the default for unregistered hosts.
 * - `session-gated` — the host is behind a WAF or needs a browser-held session
 *   (cookies bound to a TLS fingerprint, a token minted in page context).
 *   Requests must go through `browserFetch`.
 */
export type TransportTier = 'open' | 'session-gated';

/** Why a transport-tier assertion failed. */
export type TransportTierViolation = 'session-gated-over-http' | 'challenge-response';

/**
 * Thrown when a request crosses a transport tier it was not proved safe for.
 *
 * This is a bug in the calling route, not a transient network condition —
 * never catch-and-retry it. Either the endpoint needs `browserFetch`, or the
 * host's registered tier is stale and elimination should be re-run.
 */
export class TransportTierError extends Error {
	readonly url: string;
	readonly violation: TransportTierViolation;
	/** WAF vendor inferred from response headers, when the violation is a challenge. */
	readonly vendor?: string;
	/** HTTP status of the challenge response, when the violation is a challenge. */
	readonly status?: number;

	constructor(
		message: string,
		details: {
			url: string;
			violation: TransportTierViolation;
			vendor?: string;
			status?: number;
		},
	) {
		super(message);
		this.name = 'TransportTierError';
		this.url = details.url;
		this.violation = details.violation;
		this.vendor = details.vendor;
		this.status = details.status;
	}
}

// ─── Registry ────────────────────────────────────────────────────────

const tiers = new Map<string, TransportTier>();

/**
 * Record how a hostname must be reached. Call at startup alongside
 * `registerRateLimit`. Calling again for the same host replaces the tier.
 *
 * Registering `session-gated` is the durable output of an elimination pass:
 * it says "we tested this, and plain HTTP does not work."
 */
export function registerTransportTier(hostname: string, tier: TransportTier): void {
	tiers.set(hostname, tier);
	DEBUG('transport-tier', `registered ${hostname} as ${tier}`);
}

/** Tier for a URL's host. Unregistered hosts are `open`. */
export function getTransportTier(url: string | URL): TransportTier {
	try {
		return tiers.get(new URL(String(url)).hostname) ?? 'open';
	} catch {
		return 'open';
	}
}

/** All registered tiers. Useful for diagnostics and the `/health` surface. */
export function getTransportTiers(): Record<string, TransportTier> {
	return Object.fromEntries(tiers);
}

/** Drop every registered tier. Test-support only. */
export function clearTransportTiers(): void {
	tiers.clear();
}

// ─── Guard 1: the tier assertion ─────────────────────────────────────

/**
 * Refuse a plain-HTTP request to a host that needs the browser.
 *
 * Call this from any transport that does not carry a browser's fingerprint.
 * `rateLimitedFetch` calls it for you.
 */
export function assertOpenTransport(url: string | URL): void {
	const urlStr = String(url);
	if (getTransportTier(urlStr) !== 'session-gated') return;

	throw new TransportTierError(
		`Refusing a plain-HTTP request to a session-gated host: ${urlStr}. ` +
			"Node's TLS fingerprint is not a browser's, so this reads as automated traffic " +
			'however the headers are set. Route it through browserFetch, or — if elimination ' +
			'now shows the endpoint is reachable without the browser — update its ' +
			"registerTransportTier() call to 'open'.",
		{ url: urlStr, violation: 'session-gated-over-http' },
	);
}

// ─── Guard 2: challenge detection ────────────────────────────────────

/**
 * Response-header signatures that mean "bot wall", not "data".
 *
 * Deliberately narrow. Every entry is a vendor-specific header a normal API
 * response does not carry, so an ordinary 403 or 429 from a cooperating API
 * passes through untouched and the caller keeps handling it as it always did.
 * Widening this list changes existing route behavior — add a signature only
 * with a captured response that proves it.
 */
const CHALLENGE_SIGNATURES: ReadonlyArray<{
	vendor: string;
	/** True when these headers identify a bot wall rather than an origin response. */
	match: (headers: Headers, status: number) => boolean;
}> = [
	{
		// Cloudflare states the mitigation outright; this header is unambiguous.
		vendor: 'cloudflare',
		match: (h) => h.get('cf-mitigated') !== null,
	},
	{
		// An interactive challenge or a managed block: Cloudflare's edge answered,
		// the origin never saw the request. cf-ray is present on every edge response,
		// so the block status is what separates a challenge from a normal page.
		vendor: 'cloudflare',
		match: (h, status) => h.get('cf-ray') !== null && (status === 403 || status === 503),
	},
	{
		// DataDome tags its own interstitials. The cookie form appears on the
		// first block before the response header does.
		vendor: 'datadome',
		match: (h, status) =>
			h.get('x-datadome') !== null ||
			h.get('x-datadome-cid') !== null ||
			(status === 403 && (h.get('set-cookie') ?? '').includes('datadome=')),
	},
	{
		// Akamai Bot Manager returns its own error document from AkamaiGHost.
		vendor: 'akamai',
		match: (h, status) =>
			/akamaighost/i.test(h.get('server') ?? '') && (status === 403 || status === 503),
	},
	{
		// Kasada's SDK headers are present on both the block and the probe.
		vendor: 'kasada',
		match: (h) => h.get('x-kpsdk-support') !== null || h.get('x-kpsdk-cd') !== null,
	},
	{
		// PerimeterX / HUMAN.
		vendor: 'perimeterx',
		match: (h, status) => h.get('x-px-block') !== null || (status === 403 && h.has('x-px-uuid')),
	},
];

/** The WAF vendor blocking this response, or null when it is a real origin response. */
export function detectChallenge(headers: Headers, status: number): string | null {
	for (const sig of CHALLENGE_SIGNATURES) {
		if (sig.match(headers, status)) return sig.vendor;
	}
	return null;
}

/**
 * Refuse a bot-wall interstitial so it cannot be parsed as data.
 *
 * Header-only: the response body is never read, so the caller's stream stays
 * intact when this returns.
 */
export function assertNotChallenge(res: Response, url: string | URL): void {
	const vendor = detectChallenge(res.headers, res.status);
	if (!vendor) return;

	const urlStr = String(url);
	throw new TransportTierError(
		`${vendor} returned a bot-wall response (HTTP ${res.status}) for ${urlStr}, not data. ` +
			'Parsing this body would store the challenge page as a result. Reach the endpoint ' +
			`through browserFetch and register the host as session-gated so the next caller ` +
			'fails at the call site instead of here.',
		{ url: urlStr, violation: 'challenge-response', vendor, status: res.status },
	);
}
