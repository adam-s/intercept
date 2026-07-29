/**
 * Global Per-Hostname Rate Limiter
 *
 * Enforces outbound request rate limits keyed by target hostname.
 * All domain plugins share the same limiter, so two plugins hitting
 * the same external API correctly share the budget.
 *
 * Usage:
 *   import { rateLimitedFetch, registerRateLimit } from '@interceptor/shared';
 *
 *   // At startup (alongside domain registration)
 *   registerRateLimit('api.semanticscholar.org', { maxPerMinute: 10 });
 *
 *   // In route handlers — drop-in fetch replacement
 *   const res = await rateLimitedFetch('https://api.semanticscholar.org/...', { ... });
 *
 * Unregistered hosts pass through with no delay.
 *
 * @module shared/rate-limiter
 */

import { DEBUG } from './debug.js';
import { assertNotChallenge, assertOpenTransport } from './transport-tier.js';

// ─── Types ───────────────────────────────────────────────────────────

/**
 * `RequestInit` plus the one transport-tier escape hatch.
 *
 * The extra field is stripped before the underlying `fetch`, so it never
 * reaches the network layer.
 */
export interface RateLimitedFetchInit extends RequestInit {
	/**
	 * Return bot-wall responses instead of throwing `TransportTierError`.
	 *
	 * Set this only on an escalation path that reads the *status* and retries
	 * through the browser. Anything that parses the body wants the throw —
	 * that is the failure the guard exists to catch.
	 */
	allowChallengeResponse?: boolean;
}

export interface RateLimitConfig {
	/** Max requests per 60-second sliding window. */
	maxPerMinute: number;
	/** Max concurrent in-flight requests to this host. Default: maxPerMinute. */
	maxConcurrent?: number;
	/** Retry up to this many times on 429 with exponential backoff. Default: 2. */
	retryOn429?: number;
}

interface HostState {
	config: RateLimitConfig;
	/** Timestamps (ms) of requests within the sliding window. */
	timestamps: number[];
	/** Number of currently in-flight requests. */
	inflight: number;
}

// ─── Registry ────────────────────────────────────────────────────────

const hosts = new Map<string, HostState>();

/**
 * Register a rate limit for an external hostname.
 * Call at startup alongside domain plugin registration.
 * Calling again for the same host updates the config.
 */
export function registerRateLimit(hostname: string, config: RateLimitConfig): void {
	const existing = hosts.get(hostname);
	if (existing) {
		existing.config = config;
	} else {
		hosts.set(hostname, {
			config,
			timestamps: [],
			inflight: 0,
		});
	}
	DEBUG('rate-limiter', `registered ${hostname}`, () => ({ ...config }));
}

/**
 * Get rate limit configs for all registered hosts. Useful for diagnostics.
 */
export function getRateLimits(): Record<string, RateLimitConfig> {
	const result: Record<string, RateLimitConfig> = {};
	for (const [host, state] of hosts) {
		result[host] = { ...state.config };
	}
	return result;
}

// ─── Internal ────────────────────────────────────────────────────────

function getHostState(url: string): HostState | null {
	try {
		const hostname = new URL(url).hostname;
		return hosts.get(hostname) ?? null;
	} catch {
		return null;
	}
}

/** Prune timestamps older than 60s from the sliding window. */
function pruneWindow(state: HostState): void {
	const cutoff = Date.now() - 60_000;
	// timestamps are chronological — find first index >= cutoff
	let i = 0;
	while (i < state.timestamps.length && state.timestamps[i] < cutoff) {
		i++;
	}
	if (i > 0) {
		state.timestamps.splice(0, i);
	}
}

/** Wait until the host's rate limit allows a new request. */
async function waitForSlot(state: HostState): Promise<void> {
	const { maxPerMinute, maxConcurrent = maxPerMinute } = state.config;

	// Fast path: both slots available
	pruneWindow(state);
	if (state.timestamps.length < maxPerMinute && state.inflight < maxConcurrent) {
		return;
	}

	// Slow path: wait in queue
	return new Promise<void>((resolve) => {
		const check = () => {
			pruneWindow(state);
			if (state.timestamps.length < maxPerMinute && state.inflight < maxConcurrent) {
				resolve();
			} else {
				// Calculate delay until the oldest request exits the window
				const oldestAge =
					state.timestamps.length > 0 ? 60_000 - (Date.now() - state.timestamps[0]) : 1000;
				const delay = Math.max(100, Math.min(oldestAge, 5000));
				setTimeout(check, delay);
			}
		};
		// Small jitter to prevent thundering herd
		setTimeout(check, 50 + Math.random() * 100);
	});
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Wait for a rate limit slot for the given URL's host.
 * Use this when you need rate limiting but handle the fetch yourself
 * (e.g., browserFetch which uses Chrome's TLS fingerprint).
 *
 * After calling this, you MUST call `recordRateLimitedRequest(url)` when
 * the request starts, and `releaseRateLimitSlot(url)` when it completes.
 * Or use `rateLimitedFetch()` which handles all of this automatically.
 */
export async function waitForRateLimitSlot(url: string): Promise<void> {
	const state = getHostState(url);
	if (!state) return; // No rate limit registered — pass through
	await waitForSlot(state);
}

/** Record that a rate-limited request started. Call after waitForRateLimitSlot. */
export function recordRateLimitedRequest(url: string): void {
	const state = getHostState(url);
	if (!state) return;
	state.timestamps.push(Date.now());
	state.inflight++;
}

/** Release the inflight slot when a rate-limited request completes. */
export function releaseRateLimitSlot(url: string): void {
	const state = getHostState(url);
	if (!state) return;
	state.inflight = Math.max(0, state.inflight - 1);
}

/**
 * Drop-in replacement for `fetch()` that respects registered rate limits.
 * Unregistered hosts pass through immediately with no delay.
 *
 * On 429 responses, automatically retries with exponential backoff
 * (up to `retryOn429` times, default 2).
 *
 * This is the bottom rung of the transport ladder, so it also enforces the
 * ladder: a host registered `session-gated` throws before the request leaves,
 * and a WAF interstitial throws instead of being handed back as data. See
 * [transport-tier.ts](./transport-tier.ts). Pass `allowChallengeResponse: true`
 * on an escalation path that inspects the status and retries via the browser.
 */
export async function rateLimitedFetch(
	url: string | URL,
	init?: RateLimitedFetchInit,
): Promise<Response> {
	const urlStr = String(url);

	// Fails at the call site rather than one 403 later. Before the rate-limit
	// wait so a mis-tiered route doesn't spend budget proving it is mis-tiered.
	assertOpenTransport(urlStr);

	const { allowChallengeResponse = false, ...fetchInit } = init ?? {};
	const guard = (res: Response): Response => {
		if (!allowChallengeResponse) assertNotChallenge(res, urlStr);
		return res;
	};

	const state = getHostState(urlStr);

	// No rate limit registered — pass through
	if (!state) {
		return guard(await fetch(urlStr, fetchInit));
	}

	const maxRetries = state.config.retryOn429 ?? 2;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		// Wait for rate limit slot
		await waitForSlot(state);

		// Record the request
		state.timestamps.push(Date.now());
		state.inflight++;

		let res: Response;
		try {
			res = await fetch(urlStr, fetchInit);
		} finally {
			state.inflight--;
		}

		// If 429, retry with backoff
		if (res.status === 429 && attempt < maxRetries) {
			const backoffMs = 1000 * 2 ** attempt + Math.random() * 500;
			DEBUG(
				'rate-limiter',
				`429 from ${new URL(urlStr).hostname}, retry ${attempt + 1}/${maxRetries} in ${Math.round(backoffMs)}ms`,
			);
			await new Promise((r) => setTimeout(r, backoffMs));
			continue;
		}

		return guard(res);
	}

	// Should not reach here, but TypeScript needs it
	return guard(await fetch(urlStr, fetchInit));
}
